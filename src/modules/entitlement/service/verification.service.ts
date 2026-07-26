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
import {
  GooglePlayConfigError,
  InvalidPurchaseTokenError,
  UnattributableTokenError,
  UnknownProductError,
} from '../google/types.js';
import {
  elapsedMs,
  ERROR_CLASS,
  type ErrorClass,
  startTimer,
  subLog,
  subMetric,
  SUB_EVENT,
} from '../observability/index.js';
import { PurchaseOwnershipError } from '../repository/entitlement.repository.js';
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
  /**
   * Whether the purchase is ACKNOWLEDGED with Google Play at the time this
   * response is produced (backend-owned acknowledgement). The client uses this to
   * decide when it may finalize the local transaction (`completePurchase`): it
   * must not do so until the backend has verified, granted, AND acknowledged. A
   * `false` here means the ack is deferred to the acknowledgement sweep — premium
   * is still granted; the client simply keeps the purchase pending until a later
   * verify reports `true`.
   */
  acknowledged: boolean;
}

/** Outcome of a Google-driven reconcile (verify / RTDN / sweep all share it). */
export interface ReconcileOutcome {
  entitling: boolean;
  productId: string;
  state: SubscriptionState;
  expiresAt: Date | null;
  /** Final Google acknowledgement state after this reconcile (post-ack-attempt). */
  acknowledged: boolean;
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
    const started = startTimer();
    subLog('info', SUB_EVENT.VERIFY_REQUESTED, { userId, purchaseToken, source: 'client' });
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
      this.recordVerifyFailure(userId, purchaseToken, ERROR_CLASS.OWNERSHIP_CONFLICT, started);
      throw ApiError.conflict('This purchase token is already associated with another account.');
    }

    try {
      const outcome = await this.reconcileFromGoogle(userId, purchaseToken, {
        auditSource: AuditSource.CLIENT,
        successEvent: AuditEventType.VERIFY_SUCCEEDED,
      });
      incMetric(METRICS.verifySuccess, { entitling: outcome.entitling });
      const latencyMs = elapsedMs(started);
      subMetric(METRICS.verifyLatencyMs, latencyMs, { outcome: 'success', entitling: outcome.entitling });
      subLog('info', SUB_EVENT.VERIFY_SUCCEEDED, {
        userId,
        purchaseToken,
        productId: outcome.productId,
        subscriptionState: outcome.state,
        acknowledged: outcome.acknowledged,
        source: 'client',
        latencyMs,
        outcome: outcome.entitling ? 'entitling' : 'not_entitling',
      });
      return {
        isPremium: outcome.entitling,
        productId: outcome.productId,
        expiresAt: outcome.expiresAt?.toISOString() ?? null,
        acknowledged: outcome.acknowledged,
      };
    } catch (err) {
      // An ApiError bubbling out of the transaction is an already-mapped,
      // terminal client outcome — the 409 ownership conflict raised inside
      // reconcileFromGoogle under a concurrent race. Audit it as a permanent
      // failure and rethrow the 409 (never retryable, never a partial grant).
      if (err instanceof ApiError) {
        incMetric(METRICS.verifyFailure, { reason: 'ownership_conflict' });
        await this.repo.createAuditLog({
          eventType: AuditEventType.VERIFY_FAILED,
          source: AuditSource.CLIENT,
          userId,
          purchaseToken,
          processedOk: false,
          payload: { reason: 'token_owned_by_another_user', status: err.statusCode },
        });
        this.recordVerifyFailure(userId, purchaseToken, ERROR_CLASS.OWNERSHIP_CONFLICT, started);
        throw err;
      }
      const errorClass: ErrorClass =
        err instanceof InvalidPurchaseTokenError
          ? ERROR_CLASS.INVALID_TOKEN
          : err instanceof UnknownProductError
            ? ERROR_CLASS.UNKNOWN_PRODUCT
            : err instanceof GooglePlayConfigError
              ? ERROR_CLASS.NOT_CONFIGURED
              : ERROR_CLASS.UNEXPECTED;
      incMetric(METRICS.verifyFailure, { reason: errorClass });
      this.recordVerifyFailure(userId, purchaseToken, errorClass, started);
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

  /** Emits verify-failure telemetry (latency + structured log + conflict metric). */
  private recordVerifyFailure(userId: string, purchaseToken: string, errorClass: ErrorClass, started: bigint): void {
    const latencyMs = elapsedMs(started);
    subMetric(METRICS.verifyLatencyMs, latencyMs, { outcome: 'failure', errorClass });
    if (errorClass === ERROR_CLASS.OWNERSHIP_CONFLICT) {
      subMetric(METRICS.ownershipConflict, 1, { source: 'client' });
      subLog('warn', SUB_EVENT.VERIFY_OWNERSHIP_CONFLICT, {
        userId,
        purchaseToken,
        source: 'client',
        latencyMs,
        errorClass,
        outcome: 'conflict',
      });
      return;
    }
    subLog('warn', SUB_EVENT.VERIFY_FAILED, {
      userId,
      purchaseToken,
      source: 'client',
      latencyMs,
      errorClass,
      outcome: 'failure',
    });
  }

  // ── Shared Google-driven reconcile (verify / RTDN / sweep) ──────────────────────

  /**
   * Fetch the authoritative subscription state from Google, then persist it
   * (purchase + entitlement transition + audit) in one transaction and
   * acknowledge if needed. Idempotent and order-independent.
   *
   * Chain-aware: when the token is NEW but Google reports a `linkedPurchaseToken`
   * (upgrade / downgrade / resubscribe / token replacement), the subscription is
   * MIGRATED off the linked predecessor — ownership is inherited from that
   * record, the successor becomes the single active entitlement, and the
   * predecessor's entitlement is closed. See {@link resolveChainOwner}.
   *
   * @param assertedUserId The identity claiming the token: the requester for a
   *   client verify (ownership is ENFORCED against it), or `null` for an
   *   RTDN/system reconcile where ownership is derived purely from the record /
   *   chain.
   * @throws InvalidPurchaseTokenError | UnknownProductError | GooglePlayConfigError
   *   | UnattributableTokenError (unknown token, no known linked predecessor,
   *   and no asserted identity)
   */
  async reconcileFromGoogle(
    assertedUserId: string | null,
    purchaseToken: string,
    opts: ReconcileOpts,
  ): Promise<ReconcileOutcome> {
    const normalized = await this.google.getSubscription(purchaseToken);

    const productId = normalized.productId;
    if (!productId || !isKnownProductId(productId)) {
      throw new UnknownProductError(productId);
    }

    const now = new Date();
    const entitling = this.isEntitling(normalized.state, normalized.expiresAt, now);
    const linkedToken =
      normalized.linkedPurchaseToken && normalized.linkedPurchaseToken !== purchaseToken
        ? normalized.linkedPurchaseToken
        : null;

    await this.prisma.$transaction(async (tx) => {
      // 1. Serialize on BOTH the new token and its linked predecessor, in a
      //    deterministic (sorted) order so concurrent migrations of the same
      //    chain cannot deadlock or interleave. The advisory lock also covers
      //    brand-new tokens a plain FOR UPDATE cannot lock (no row yet).
      for (const t of [purchaseToken, linkedToken].filter((x): x is string => x !== null).sort()) {
        await this.repo.acquireTokenLock(t, tx);
      }
      const locked = await this.repo.lockPurchaseOwner(purchaseToken, tx);

      // 2. Resolve the predecessor (only when this token is new AND links back).
      //    Row-locked so it cannot be mutated concurrently during the migration.
      const predecessor =
        !locked && linkedToken ? await this.repo.lockPurchaseOwner(linkedToken, tx) : null;
      const isMigration = predecessor !== null;

      // 3. Determine the authoritative owner: an existing row for this token,
      //    else the linked predecessor's owner, else the asserted (client)
      //    identity. Ownership is INHERITED from the chain and never invented.
      const ownerUserId = locked?.userId ?? predecessor?.userId ?? assertedUserId;
      if (ownerUserId === null) {
        // Unknown token, no known predecessor, no asserted identity (RTDN for a
        // chain we've never seen). Terminal-but-harmless for the caller.
        throw new UnattributableTokenError(purchaseToken, linkedToken);
      }

      // 4. Ownership ENFORCEMENT against the asserted (client) identity. A client
      //    can never claim a token — or a chain — that belongs to someone else.
      if (assertedUserId !== null && ownerUserId !== assertedUserId) {
        throw ApiError.conflict('This purchase token is already associated with another account.');
      }

      let row;
      try {
        row = await this.repo.upsertVerifiedPurchase(
          {
            userId: ownerUserId,
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
        // Ownership guard in the repo, or the unique constraint under a truly
        // concurrent insert — both mean the token belongs to another account.
        if (err instanceof PurchaseOwnershipError || isUniqueViolation(err)) {
          throw ApiError.conflict('This purchase token is already associated with another account.');
        }
        throw err;
      }

      const source = String(opts.auditSource).toLowerCase();

      if (entitling) {
        await this.entitlements.grantWithinTx(tx, {
          userId: ownerUserId,
          entitlement: EntitlementType.PREMIUM,
          source: EntitlementSource.SUBSCRIPTION,
          sourceRef: row.id,
          expiresAt: normalized.expiresAt,
          reason: isMigration ? EntitlementChangeReason.RENEWAL : EntitlementChangeReason.PURCHASE_VERIFIED,
          relatedPurchaseId: row.id,
        });
        subLog('info', SUB_EVENT.ENTITLEMENT_GRANTED, {
          userId: ownerUserId,
          purchaseToken,
          productId,
          orderId: normalized.orderId,
          subscriptionState: normalized.state,
          acknowledged: normalized.acknowledged,
          linkedPurchaseToken: normalized.linkedPurchaseToken,
          source,
          outcome: isMigration ? 'migrated' : 'granted',
        });

        // 5. MIGRATION: the successor is now the single active entitlement, so
        //    close the predecessor's own entitlement (by its sourceRef — never
        //    the coarse "active premium", which would close the successor we just
        //    granted) and mark the predecessor purchase terminal so no later
        //    event (sweep / out-of-order RTDN) re-processes it.
        if (isMigration && predecessor) {
          await this.entitlements.closeBySourceWithinTx(
            tx,
            ownerUserId,
            EntitlementType.PREMIUM,
            EntitlementSource.SUBSCRIPTION,
            predecessor.id,
            EntitlementStatus.EXPIRED,
            EntitlementChangeReason.EXPIRY,
            row.id,
          );
          await this.repo.setPurchaseState(predecessor.id, SubscriptionState.EXPIRED, tx);
          subMetric(METRICS.linkedMigration, 1, { source });
          subLog('info', SUB_EVENT.MIGRATION_APPLIED, {
            userId: ownerUserId,
            purchaseToken,
            productId,
            linkedPurchaseToken: linkedToken,
            source,
            outcome: 'migrated',
          });
        }
      } else {
        // Not entitling (expired / on-hold / paused / pending): suspend THIS
        // token's own entitlement only (source-specific), never a sibling link's.
        await this.entitlements.closeBySourceWithinTx(
          tx,
          ownerUserId,
          EntitlementType.PREMIUM,
          EntitlementSource.SUBSCRIPTION,
          row.id,
          EntitlementStatus.EXPIRED,
          EntitlementChangeReason.EXPIRY,
          row.id,
        );
        subLog('info', SUB_EVENT.ENTITLEMENT_SUSPENDED, {
          userId: ownerUserId,
          purchaseToken,
          productId,
          subscriptionState: normalized.state,
          source,
          outcome: 'not_entitling',
        });
      }

      await this.repo.createAuditLog(
        {
          eventType: opts.successEvent,
          source: opts.auditSource,
          userId: ownerUserId,
          purchaseToken,
          payload: {
            productId,
            state: normalized.state,
            entitling,
            expiresAt: normalized.expiresAt?.toISOString() ?? null,
            ...(isMigration && predecessor
              ? { migratedFromToken: linkedToken, migratedFromPurchaseId: predecessor.id }
              : {}),
          },
        },
        tx,
      );

      return row;
    });

    // Backend-owned acknowledgement, performed AFTER the grant is durably
    // committed (a failed ack must never lose the entitlement). The entitlement
    // is already granted, so this is safe to retry via the acknowledgement sweep
    // until it converges, well within Google's 3-day auto-refund window.
    let acknowledged = normalized.acknowledged;
    if (entitling && !normalized.acknowledged) {
      acknowledged = await this.acknowledgeIfNeeded(productId, purchaseToken);
    }

    return { entitling, productId, state: normalized.state, expiresAt: normalized.expiresAt, acknowledged };
  }

  /**
   * Acknowledge a purchase with Google EXACTLY ONCE, idempotently, under the
   * per-token advisory lock. Re-reads the PERSISTED acknowledgement flag inside
   * the lock and skips the network call if a concurrent verify / RTDN / sweep
   * already acknowledged it — so duplicate/concurrent verification, retries, and
   * a resumed sweep after a server restart can never double-acknowledge or
   * "retry unnecessarily for an already acknowledged purchase". Returns the final
   * acknowledgement state; a transient Google failure returns false (grant is
   * untouched; the sweep retries).
   *
   * The single Google call runs inside the lock's transaction. That briefly
   * holds a lightweight advisory lock across the ack request — the trade for
   * exactly-once semantics — but never across the grant (which is already
   * committed), so the entitlement is never at risk.
   */
  private async acknowledgeIfNeeded(productId: string, purchaseToken: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.repo.acquireTokenLock(purchaseToken, tx);
      const row = await this.repo.findPurchaseByToken(purchaseToken, tx);
      if (!row) return false;
      if (row.acknowledged) {
        // already acknowledged by a racer / prior sweep — no unnecessary retry
        subLog('info', SUB_EVENT.ACK_SKIPPED, { userId: row.userId, purchaseToken, productId, outcome: 'already_acknowledged' });
        return true;
      }
      const startedAck = startTimer();
      try {
        await this.google.acknowledgeSubscription(productId, purchaseToken);
        await this.repo.setAcknowledged(row.id, tx);
        const latencyMs = elapsedMs(startedAck);
        incMetric(METRICS.ackSuccess);
        subMetric(METRICS.ackLatencyMs, latencyMs, { outcome: 'success' });
        subLog('info', SUB_EVENT.ACK_SUCCEEDED, { userId: row.userId, purchaseToken, productId, latencyMs, outcome: 'acknowledged' });
        return true;
      } catch (err) {
        // Non-fatal: the sweep is the durable retry. `acknowledged` stays false
        // so the client keeps the purchase pending and does not finalize yet.
        const latencyMs = elapsedMs(startedAck);
        incMetric(METRICS.ackFailure);
        subMetric(METRICS.ackLatencyMs, latencyMs, { outcome: 'failure' });
        subLog('error', SUB_EVENT.ACK_FAILED, {
          userId: row.userId,
          purchaseToken,
          productId,
          latencyMs,
          errorClass: ERROR_CLASS.GOOGLE_API,
          outcome: 'failed',
        });
        logger.error({ err, purchaseId: row.id }, 'Failed to acknowledge Google Play purchase (sweep will retry)');
        return false;
      }
    });
  }

  // ── Force transitions (RTDN revoke / expire, sweep fallbacks) ───────────────────

  /**
   * Immediately revoke entitlement for a token (refund / chargeback / explicit
   * revoke). Does NOT depend on a successful Google fetch — a fully refunded
   * token may 410 on subscriptionsv2.get. No-op if the purchase is unknown.
   */
  async revokeByToken(purchaseToken: string, auditSource: AuditSource): Promise<void> {
    const purchase = await this.repo.findPurchaseByToken(purchaseToken);
    if (!purchase) return;
    // Ownership is derived from the purchase record — never a caller parameter —
    // so a revoke can only ever touch the token's true owner.
    const ownerUserId = purchase.userId;
    await this.prisma.$transaction(async (tx) => {
      await this.repo.acquireTokenLock(purchaseToken, tx);
      await this.repo.setPurchaseState(purchase.id, SubscriptionState.REVOKED, tx);
      // Close THIS purchase's own entitlement (source-specific): a refund/void of
      // a superseded token in a chain must never revoke the successor's premium.
      await this.entitlements.closeBySourceWithinTx(
        tx,
        ownerUserId,
        EntitlementType.PREMIUM,
        EntitlementSource.SUBSCRIPTION,
        purchase.id,
        EntitlementStatus.REVOKED,
        EntitlementChangeReason.REVOCATION,
        purchase.id,
      );
      await this.repo.createAuditLog(
        {
          eventType: AuditEventType.ENTITLEMENT_REVOKED,
          source: auditSource,
          userId: ownerUserId,
          purchaseToken,
          payload: { reason: 'revoked' },
        },
        tx,
      );
    });
    subLog('warn', SUB_EVENT.ENTITLEMENT_REVOKED, {
      userId: ownerUserId,
      purchaseToken,
      source: String(auditSource).toLowerCase(),
      outcome: 'revoked',
    });
  }

  /**
   * Force a token to EXPIRED — used when Google reports the subscription is gone
   * (e.g. subscriptionsv2.get 410 during a sweep). No-op if unknown.
   */
  async expireByToken(purchaseToken: string, auditSource: AuditSource): Promise<void> {
    const purchase = await this.repo.findPurchaseByToken(purchaseToken);
    if (!purchase) return;
    // Ownership derived from the purchase record, never a caller parameter.
    const ownerUserId = purchase.userId;
    await this.prisma.$transaction(async (tx) => {
      await this.repo.acquireTokenLock(purchaseToken, tx);
      await this.repo.setPurchaseState(purchase.id, SubscriptionState.EXPIRED, tx);
      // Source-specific close: expiring an old/superseded token must not expire
      // the successor's entitlement.
      await this.entitlements.closeBySourceWithinTx(
        tx,
        ownerUserId,
        EntitlementType.PREMIUM,
        EntitlementSource.SUBSCRIPTION,
        purchase.id,
        EntitlementStatus.EXPIRED,
        EntitlementChangeReason.EXPIRY,
        purchase.id,
      );
      await this.repo.createAuditLog(
        {
          eventType: AuditEventType.ENTITLEMENT_EXPIRED,
          source: auditSource,
          userId: ownerUserId,
          purchaseToken,
          payload: { reason: 'expired' },
        },
        tx,
      );
    });
    subLog('info', SUB_EVENT.ENTITLEMENT_EXPIRED, {
      userId: ownerUserId,
      purchaseToken,
      source: String(auditSource).toLowerCase(),
      outcome: 'expired',
    });
  }

  private isEntitling(state: SubscriptionState, expiresAt: Date | null, now: Date): boolean {
    return ENTITLING_SUBSCRIPTION_STATES.has(state) && expiresAt !== null && expiresAt > now;
  }
}
