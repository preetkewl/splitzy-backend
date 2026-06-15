import type { SubscriptionPurchase } from '@prisma/client';
import { ALERT_THRESHOLDS, METRICS } from '../../../constants/metrics.js';
import { logger } from '../../../utils/logger.js';
import { emitAlert, emitMetric } from '../../../utils/metrics.js';
import { AuditEventType, AuditSource } from '../constants.js';
import type { GooglePlayClient } from '../google/google-play-client.js';
import { GooglePlayConfigError, InvalidPurchaseTokenError, UnknownProductError } from '../google/types.js';
import type { EntitlementRepository } from '../repository/entitlement.repository.js';
import type { VerificationService } from './verification.service.js';

export interface SweepSummary {
  scanned: number;
  reconciled: number;
  expired: number;
  failed: number;
  durationMs: number;
}

const DEFAULT_LIMIT = 200;

/**
 * Operational safety net. RTDN is best-effort (Pub/Sub can drop / delay /
 * dead-letter), so these periodic sweeps re-derive truth from Google and repair
 * drift. Both are idempotent and bounded, and reuse the same
 * {@link VerificationService.reconcileFromGoogle} path as verify/RTDN — so there
 * is exactly one place that maps Google state onto entitlements.
 *
 * Run from cron (see scripts/ack-purchases.ts, scripts/reconcile-subscriptions.ts).
 */
export class ReconciliationService {
  constructor(
    private readonly repo: EntitlementRepository,
    private readonly verification: VerificationService,
    private readonly google: GooglePlayClient,
  ) {}

  /**
   * Acknowledgment recovery: re-process not-yet-acknowledged entitling purchases
   * so a failed post-verify ack does not let Google auto-refund after 3 days.
   * reconcileFromGoogle persists Google's current ack state and acknowledges if
   * still required — so this both recovers AND avoids duplicate acks.
   */
  runAcknowledgementSweep(limit = DEFAULT_LIMIT): Promise<SweepSummary> {
    return this.sweep('acknowledgement', () => this.repo.listUnacknowledgedPurchases(limit), limit);
  }

  /**
   * Full reconciliation: re-derive every non-terminal purchase against Google,
   * repairing state missed by RTDN (renewals, cancellations, lapses, refunds).
   */
  runReconciliationSweep(limit = DEFAULT_LIMIT): Promise<SweepSummary> {
    return this.sweep('reconciliation', () => this.repo.listReconcilablePurchases(limit), limit);
  }

  private async sweep(
    name: string,
    fetchBatch: () => Promise<SubscriptionPurchase[]>,
    limit: number,
  ): Promise<SweepSummary> {
    if (!this.google.isConfigured) {
      logger.warn({ sweep: name }, 'sweep skipped — Google Play not configured');
      return { scanned: 0, reconciled: 0, expired: 0, failed: 0, durationMs: 0 };
    }

    const startedAt = Date.now();
    const batch = await fetchBatch();
    const summary: SweepSummary = { scanned: batch.length, reconciled: 0, expired: 0, failed: 0, durationMs: 0 };

    for (const purchase of batch) {
      try {
        await this.verification.reconcileFromGoogle(purchase.userId, purchase.purchaseToken, {
          auditSource: AuditSource.SYSTEM,
          successEvent: AuditEventType.PURCHASE_UPDATED,
        });
        summary.reconciled += 1;
      } catch (err) {
        if (err instanceof InvalidPurchaseTokenError) {
          // Google dropped the token → the subscription ended. Expire locally.
          await this.verification.expireByToken(purchase.userId, purchase.purchaseToken, AuditSource.SYSTEM);
          summary.expired += 1;
          continue;
        }
        if (err instanceof GooglePlayConfigError) {
          // Configuration broke mid-run — stop; nothing else will succeed.
          logger.error({ sweep: name }, 'sweep aborted — Google Play config error');
          break;
        }
        if (err instanceof UnknownProductError) {
          logger.error({ purchaseId: purchase.id, productId: err.productId }, 'sweep unrecognized product');
          summary.failed += 1;
          continue;
        }
        logger.error({ err, purchaseId: purchase.id, sweep: name }, 'sweep item failed');
        summary.failed += 1;
      }
    }

    summary.durationMs = Date.now() - startedAt;

    // ── Metrics + alerts ──────────────────────────────────────────────────────
    emitMetric(METRICS.reconcileScanned, summary.scanned, { sweep: name });
    emitMetric(METRICS.reconcileReconciled, summary.reconciled, { sweep: name });
    emitMetric(METRICS.reconcileExpired, summary.expired, { sweep: name });
    emitMetric(METRICS.reconcileFailed, summary.failed, { sweep: name });

    // Authoritative ack-backlog gauge AFTER the sweep (what's still at refund
    // risk). Alert if anything remains unacknowledged.
    const ackBacklog = await this.repo.countUnacknowledged();
    emitMetric(METRICS.ackBacklog, ackBacklog, { sweep: name });
    if (ackBacklog >= ALERT_THRESHOLDS.ackBacklog) {
      emitAlert('ack_backlog_nonzero', 'critical', { backlog: ackBacklog, sweep: name });
    }
    if (summary.failed >= ALERT_THRESHOLDS.sweepFailed) {
      emitAlert('sweep_item_failures', 'warning', { failed: summary.failed, sweep: name });
    }

    logger.info({ sweep: name, limit, ackBacklog, ...summary }, 'sweep complete');
    return summary;
  }
}
