import { Prisma, type PrismaClient } from '@prisma/client';
import { METRICS } from '../../../constants/metrics.js';
import { ApiError } from '../../../core/api-error.js';
import { logger } from '../../../utils/logger.js';
import { incMetric } from '../../../utils/metrics.js';
import {
  AuditEventType,
  AuditSource,
  ENTITLING_SUBSCRIPTION_STATES,
  EntitlementChangeReason,
  EntitlementSource,
  EntitlementStatus,
  EntitlementType,
  isKnownProductId,
  SubscriptionState,
} from '../constants.js';
import type { GooglePlayClient } from '../google/google-play-client.js';
import { GooglePlayConfigError, InvalidPurchaseTokenError, UnknownProductError } from '../google/types.js';
import type { EntitlementRepository } from '../repository/entitlement.repository.js';
import type { EntitlementService } from './entitlement.service.js';

/**
 * Result of a verify call. Shape kept aligned with the existing
 * SubscriptionStatusDto so the legacy `/subscriptions/verify` response contract
 * (and the frontend reading it) is unchanged.
 */
export interface VerificationResult {
  isPremium: boolean;
  productId: string | null;
  expiresAt: string | null;
}

/** Outcome of a Google-driven reconcile (verify / RTDN / sweep all share it). */
export interface ReconcileOutcome {
  entitling: boolean;
  productId: string;
  state: SubscriptionState;
  expiresAt: Date | null;
}

interface ReconcileOpts {
  auditSource: AuditSource;
  successEvent: AuditEventType;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Real Google Play verification + lifecycle synchronization — the backend's
 * authority.
 *
 * The ONLY trusted inputs are the user's identity and an opaque purchaseToken.
 * Product, state, expiry, auto-renew and acknowledgement are ALWAYS derived from
 * Google's `purchases.subscriptionsv2.get`. This is also why RTDN is safe and
 * order-independent: every lifecycle signal triggers a fresh fetch, so we always
 * persist Google's CURRENT truth rather than a (possibly stale, possibly
 * out-of-order) notification payload.
 */
export class VerificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: EntitlementRepository,
    private readonly entitlements: EntitlementService,
    private readonly google: GooglePlayClient,
  ) {}

  // ── Client-facing verify ──────────────────────────────────────────────────────

  async verify(userId: string, purchaseToken: string): Promise<VerificationResult> {
    await this.repo.createAuditLog({
      eventType: AuditEventType.VERIFY_REQUESTED,
      source: AuditSource.CLIENT,
      userId,
      purchaseToken,
    });

    // Replay / token-sharing guard — a token already bound to another user is
    // never re-bound or re-granted. The DB unique constraint guards the
    // concurrent race; this catches the common case with a clear 409.
    const existing = await this.repo.findPurchaseByToken(purchaseToken);
    if (existing && existing.userId !== userId) {
      await this.repo.createAuditLog({
        eventType: AuditEventType.VERIFY_FAILED,
        source: AuditSource.CLIENT,
        userId,
        purchaseToken,
        processedOk: false,
        payload: { reason: 'token_owned_by_another_user', ownerUserId: existing.userId },
      });
      throw ApiError.conflict('This purchase token is already associated with another account.');
    }

    try {
      const outcome = await this.reconcileFromGoogle(userId, purchaseToken, {
        auditSource: AuditSource.CLIENT,
        successEvent: AuditEventType.VERIFY_SUCCEEDED,
      });
      incMetric(METRICS.verifySuccess, { entitling: outcome.entitling });
      return {
        isPremium: outcome.entitling,
        productId: outcome.productId,
        expiresAt: outcome.expiresAt?.toISOString() ?? null,
      };
    } catch (err) {
      incMetric(METRICS.verifyFailure, {
        reason:
          err instanceof InvalidPurchaseTokenError
            ? 'invalid_token'
            : err instanceof UnknownProductError
              ? 'unknown_product'
              : err instanceof GooglePlayConfigError
                ? 'not_configured'
                : 'unexpected',
      });
      if (err instanceof InvalidPurchaseTokenError) {
        await this.repo.createAuditLog({
          eventType: AuditEventType.VERIFY_FAILED,
          source: AuditSource.CLIENT,
          userId,
          purchaseToken,
          processedOk: false,
          payload: { reason: 'invalid_token' },
        });
        throw ApiError.badRequest('Invalid or unrecognized purchase token.');
      }
      if (err instanceof UnknownProductError) {
        await this.repo.createAuditLog({
          eventType: AuditEventType.VERIFY_FAILED,
          source: AuditSource.CLIENT,
          userId,
          purchaseToken,
          processedOk: false,
          payload: { reason: 'unrecognized_product', productId: err.productId },
        });
        throw ApiError.badRequest('Unrecognized subscription product.');
      }
      if (err instanceof GooglePlayConfigError) {
        await this.repo.createAuditLog({
          eventType: AuditEventType.VERIFY_FAILED,
          source: AuditSource.SYSTEM,
          userId,
          purchaseToken,
          processedOk: false,
          payload: { reason: 'verification_not_configured' },
        });
        throw ApiError.internal('Subscription verification is temporarily unavailable.');
      }
      logger.error({ err, userId }, 'Unexpected Google Play verification error');
      throw err;
    }
  }

  // ── Shared Google-driven reconcile (verify / RTDN / sweep) ──────────────────────

  /**
   * Fetch the authoritative subscription state from Google, then persist it
   * (purchase + entitlement transition + audit) in one transaction and
   * acknowledge if needed. Idempotent and order-independent.
   *
   * @throws InvalidPurchaseTokenError | UnknownProductError | GooglePlayConfigError
   */
  async reconcileFromGoogle(userId: string, purchaseToken: string, opts: ReconcileOpts): Promise<ReconcileOutcome> {
    const normalized = await this.google.getSubscription(purchaseToken);

    const productId = normalized.productId;
    if (!productId || !isKnownProductId(productId)) {
      throw new UnknownProductError(productId);
    }

    const now = new Date();
    const entitling = this.isEntitling(normalized.state, normalized.expiresAt, now);

    const purchase = await this.prisma.$transaction(async (tx) => {
      let row;
      try {
        row = await this.repo.upsertVerifiedPurchase(
          {
            userId,
            purchaseToken,
            productId,
            state: normalized.state,
            orderId: normalized.orderId,
            purchasedAt: normalized.purchasedAt,
            expiresAt: normalized.expiresAt,
            autoRenewing: normalized.autoRenewing,
            acknowledged: normalized.acknowledged,
            linkedPurchaseToken: normalized.linkedPurchaseToken,
            latestGoogleState: normalized.raw,
          },
          tx,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw ApiError.conflict('This purchase token is already associated with another account.');
        }
        throw err;
      }

      if (entitling) {
        await this.entitlements.grantWithinTx(tx, {
          userId,
          entitlement: EntitlementType.PREMIUM,
          source: EntitlementSource.SUBSCRIPTION,
          sourceRef: row.id,
          expiresAt: normalized.expiresAt,
          reason: EntitlementChangeReason.PURCHASE_VERIFIED,
          relatedPurchaseId: row.id,
        });
      } else {
        // Not entitling (expired / on-hold / paused / pending): suspend any
        // active premium for this user. No-op if none active.
        await this.entitlements.closeWithinTx(
          tx,
          userId,
          EntitlementType.PREMIUM,
          EntitlementStatus.EXPIRED,
          EntitlementChangeReason.EXPIRY,
          row.id,
        );
      }

      await this.repo.createAuditLog(
        {
          eventType: opts.successEvent,
          source: opts.auditSource,
          userId,
          purchaseToken,
          payload: {
            productId,
            state: normalized.state,
            entitling,
            expiresAt: normalized.expiresAt?.toISOString() ?? null,
          },
        },
        tx,
      );

      return row;
    });

    // Acknowledge AFTER commit (no network inside the tx). Non-fatal — the
    // entitlement is already granted; the ack sweep retries if this fails.
    if (entitling && !normalized.acknowledged) {
      try {
        await this.google.acknowledgeSubscription(productId, purchaseToken);
        await this.repo.setAcknowledged(purchase.id);
      } catch (err) {
        logger.error({ err, purchaseId: purchase.id }, 'Failed to acknowledge Google Play purchase');
      }
    }

    return { entitling, productId, state: normalized.state, expiresAt: normalized.expiresAt };
  }

  // ── Force transitions (RTDN revoke / expire, sweep fallbacks) ───────────────────

  /**
   * Immediately revoke entitlement for a token (refund / chargeback / explicit
   * revoke). Does NOT depend on a successful Google fetch — a fully refunded
   * token may 410 on subscriptionsv2.get. No-op if the purchase is unknown.
   */
  async revokeByToken(userId: string, purchaseToken: string, auditSource: AuditSource): Promise<void> {
    const purchase = await this.repo.findPurchaseByToken(purchaseToken);
    if (!purchase) return;
    await this.prisma.$transaction(async (tx) => {
      await this.repo.setPurchaseState(purchase.id, SubscriptionState.REVOKED, tx);
      await this.entitlements.closeWithinTx(
        tx,
        userId,
        EntitlementType.PREMIUM,
        EntitlementStatus.REVOKED,
        EntitlementChangeReason.REVOCATION,
        purchase.id,
      );
      await this.repo.createAuditLog(
        {
          eventType: AuditEventType.ENTITLEMENT_REVOKED,
          source: auditSource,
          userId,
          purchaseToken,
          payload: { reason: 'revoked' },
        },
        tx,
      );
    });
  }

  /**
   * Force a token to EXPIRED — used when Google reports the subscription is gone
   * (e.g. subscriptionsv2.get 410 during a sweep). No-op if unknown.
   */
  async expireByToken(userId: string, purchaseToken: string, auditSource: AuditSource): Promise<void> {
    const purchase = await this.repo.findPurchaseByToken(purchaseToken);
    if (!purchase) return;
    await this.prisma.$transaction(async (tx) => {
      await this.repo.setPurchaseState(purchase.id, SubscriptionState.EXPIRED, tx);
      await this.entitlements.closeWithinTx(
        tx,
        userId,
        EntitlementType.PREMIUM,
        EntitlementStatus.EXPIRED,
        EntitlementChangeReason.EXPIRY,
        purchase.id,
      );
      await this.repo.createAuditLog(
        {
          eventType: AuditEventType.ENTITLEMENT_EXPIRED,
          source: auditSource,
          userId,
          purchaseToken,
          payload: { reason: 'expired' },
        },
        tx,
      );
    });
  }

  private isEntitling(state: SubscriptionState, expiresAt: Date | null, now: Date): boolean {
    return ENTITLING_SUBSCRIPTION_STATES.has(state) && expiresAt !== null && expiresAt > now;
  }
}
