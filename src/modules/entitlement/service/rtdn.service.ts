import { Prisma } from '@prisma/client';
import { METRICS } from '../../../constants/metrics.js';
import { logger } from '../../../utils/logger.js';
import { incMetric } from '../../../utils/metrics.js';
import { AuditEventType, AuditSource } from '../constants.js';
import {
  type DeveloperNotification,
  SUB_NOTIFICATION,
  SUB_NOTIFICATION_NAME,
} from '../google/rtdn-types.js';
import { GooglePlayConfigError, InvalidPurchaseTokenError, UnknownProductError } from '../google/types.js';
import type { EntitlementRepository } from '../repository/entitlement.repository.js';
import type { VerificationService } from './verification.service.js';

export type RtdnStatus =
  | 'duplicate'
  | 'processed'
  | 'test'
  | 'ignored'
  | 'malformed'
  | 'unknown_purchase';

export interface RtdnOutcome {
  status: RtdnStatus;
  notificationType?: string;
  purchaseToken?: string;
}

/** A transient failure — the caller should return 5xx so Pub/Sub retries. */
export class RtdnRetryableError extends Error {
  constructor(
    message: string,
    public readonly reason?: unknown,
  ) {
    super(message);
    this.name = 'RtdnRetryableError';
  }
}

interface IncomingMessage {
  data: string;
  messageId: string;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * RTDN processor — keeps backend entitlement state synchronized with the Google
 * Play subscription lifecycle.
 *
 * Design invariants:
 *   • Idempotent: each Pub/Sub messageId is processed at most once (audit-log
 *     unique key). Duplicates NO-OP.
 *   • RTDN is a SIGNAL, never the source of truth — every event triggers a fresh
 *     subscriptionsv2.get, so out-of-order / delayed delivery cannot corrupt
 *     state (the latest fetch always wins).
 *   • Retry-safe: transient failures throw {@link RtdnRetryableError} so the
 *     webhook returns 5xx and Pub/Sub redelivers; terminal cases return a status
 *     and 200 so they are not retried forever.
 */
export class RtdnService {
  constructor(
    private readonly repo: EntitlementRepository,
    private readonly verification: VerificationService,
  ) {}

  async processPushMessage(msg: IncomingMessage): Promise<RtdnOutcome> {
    // 1. Idempotency gate — already processed this messageId?
    const seen = await this.repo.findAuditByGoogleMessageId(msg.messageId);
    if (seen) {
      logger.info({ messageId: msg.messageId }, 'rtdn duplicate ignored');
      incMetric(METRICS.rtdnDuplicate);
      return { status: 'duplicate' };
    }

    // 2. Decode the DeveloperNotification.
    let notification: DeveloperNotification;
    try {
      const json = Buffer.from(msg.data, 'base64').toString('utf8');
      notification = JSON.parse(json) as DeveloperNotification;
    } catch (err) {
      logger.error({ err, messageId: msg.messageId }, 'rtdn malformed payload');
      await this.recordProcessed(msg.messageId, AuditEventType.RTDN_RECEIVED, null, {
        reason: 'malformed',
        processedOk: false,
      });
      return { status: 'malformed' };
    }

    if (notification.testNotification) {
      logger.info({ messageId: msg.messageId }, 'rtdn test notification');
      await this.recordProcessed(msg.messageId, AuditEventType.RTDN_RECEIVED, null, { reason: 'test' });
      return { status: 'test' };
    }

    // 3. Resolve the affected token + routing.
    const voided = notification.voidedPurchaseNotification;
    const sub = notification.subscriptionNotification;
    const purchaseToken = voided?.purchaseToken ?? sub?.purchaseToken ?? null;
    const notificationType = sub?.notificationType;
    const typeName = voided
      ? 'VOIDED_PURCHASE'
      : (notificationType !== undefined ? SUB_NOTIFICATION_NAME[notificationType] : undefined) ?? 'UNKNOWN';

    if (!purchaseToken) {
      // oneTimeProduct / unrecognized — nothing for the subscription flow to do.
      logger.info({ messageId: msg.messageId, typeName }, 'rtdn ignored (no purchase token)');
      await this.recordProcessed(msg.messageId, AuditEventType.RTDN_RECEIVED, null, { reason: 'no_token', typeName });
      return { status: 'ignored', notificationType: typeName };
    }

    // 4. Resolve the user from the existing purchase row. RTDN carries no userId.
    const purchase = await this.repo.findPurchaseByToken(purchaseToken);
    if (!purchase) {
      // We have never seen this token (e.g. RTDN arrived before verify). Record
      // and ack to avoid a retry storm; the reconciliation sweep + a later verify
      // re-derive truth, so no permanent drift.
      logger.warn({ messageId: msg.messageId, typeName }, 'rtdn for unknown purchase token');
      await this.recordProcessed(msg.messageId, AuditEventType.RTDN_RECEIVED, purchaseToken, {
        reason: 'unknown_purchase',
        processedOk: false,
        typeName,
      });
      return { status: 'unknown_purchase', notificationType: typeName, purchaseToken };
    }

    // 5. Route. Revoke is force-applied (does not depend on a Google fetch);
    //    everything else re-fetches Google and derives the authoritative state.
    const isRevoke = Boolean(voided) || notificationType === SUB_NOTIFICATION.REVOKED;
    try {
      if (isRevoke) {
        await this.verification.revokeByToken(purchase.userId, purchaseToken, AuditSource.RTDN);
      } else {
        await this.syncFromGoogle(purchase.userId, purchaseToken);
      }
    } catch (err) {
      incMetric(METRICS.rtdnFailure, { typeName });
      if (err instanceof GooglePlayConfigError) {
        // Misconfiguration / transient auth — let Pub/Sub retry.
        throw new RtdnRetryableError('verification not configured', err);
      }
      // Unexpected (network/5xx etc.) — retry.
      logger.error({ err, messageId: msg.messageId, typeName }, 'rtdn processing failed');
      throw new RtdnRetryableError('rtdn processing failed', err);
    }

    // 6. Mark this messageId processed (the dedup marker). A concurrent
    //    duplicate that raced past step 1 hits the unique constraint here — fine.
    await this.recordProcessed(msg.messageId, AuditEventType.RTDN_RECEIVED, purchaseToken, { typeName });
    logger.info({ messageId: msg.messageId, typeName, userId: purchase.userId }, 'rtdn processed');
    incMetric(METRICS.rtdnProcessed, { typeName, revoke: isRevoke });
    return { status: 'processed', notificationType: typeName, purchaseToken };
  }

  /** Re-fetch Google and reconcile; if Google says the token is gone, expire it. */
  private async syncFromGoogle(userId: string, purchaseToken: string): Promise<void> {
    try {
      await this.verification.reconcileFromGoogle(userId, purchaseToken, {
        auditSource: AuditSource.RTDN,
        successEvent: AuditEventType.PURCHASE_UPDATED,
      });
    } catch (err) {
      if (err instanceof InvalidPurchaseTokenError) {
        // Google no longer recognizes the token → the subscription is gone.
        await this.verification.expireByToken(userId, purchaseToken, AuditSource.RTDN);
        return;
      }
      if (err instanceof UnknownProductError) {
        // Known purchase, but Google now reports an unrecognized product. Don't
        // retry forever — log and treat as handled.
        logger.error({ purchaseToken, productId: err.productId }, 'rtdn unrecognized product');
        return;
      }
      throw err;
    }
  }

  private async recordProcessed(
    messageId: string,
    eventType: AuditEventType,
    purchaseToken: string | null,
    payload: Record<string, unknown> & { processedOk?: boolean },
  ): Promise<void> {
    const { processedOk, ...rest } = payload;
    try {
      await this.repo.createAuditLog({
        eventType,
        source: AuditSource.RTDN,
        purchaseToken,
        googleMessageId: messageId,
        processedOk: processedOk ?? true,
        payload: rest as Prisma.InputJsonValue,
      });
    } catch (err) {
      // Unique-violation = a concurrent delivery already wrote the marker.
      if (!isUniqueViolation(err)) throw err;
    }
  }
}
