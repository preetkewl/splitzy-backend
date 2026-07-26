import { getCorrelationId } from './correlation.js';
import { hashOrderId, hashPurchaseToken, linkedTokenPresent } from './redaction.js';

/**
 * Canonical, stable event names for the Google Play billing lifecycle. Every
 * structured subscription log line uses one of these under the `event` field, so
 * dashboards and log queries key off a fixed vocabulary rather than free text.
 *
 * Namespacing: `subscription.<stage>.<outcome>`.
 */
export const SUB_EVENT = {
  // Purchase received / verification (client-facing)
  VERIFY_REQUESTED: 'subscription.verify.requested',
  VERIFY_SUCCEEDED: 'subscription.verify.succeeded',
  VERIFY_FAILED: 'subscription.verify.failed',
  VERIFY_OWNERSHIP_CONFLICT: 'subscription.verify.ownership_conflict',
  // Entitlement
  ENTITLEMENT_GRANTED: 'subscription.entitlement.granted',
  ENTITLEMENT_SUSPENDED: 'subscription.entitlement.suspended',
  ENTITLEMENT_REVOKED: 'subscription.entitlement.revoked',
  ENTITLEMENT_EXPIRED: 'subscription.entitlement.expired',
  // Acknowledgement (backend-owned)
  ACK_SUCCEEDED: 'subscription.ack.succeeded',
  ACK_FAILED: 'subscription.ack.failed',
  ACK_SKIPPED: 'subscription.ack.skipped',
  // linkedPurchaseToken migration (upgrade / downgrade / resubscribe / replace)
  MIGRATION_APPLIED: 'subscription.migration.applied',
  // RTDN
  RTDN_RECEIVED: 'subscription.rtdn.received',
  RTDN_PROCESSED: 'subscription.rtdn.processed',
  RTDN_DUPLICATE: 'subscription.rtdn.duplicate',
  RTDN_UNKNOWN_TOKEN: 'subscription.rtdn.unknown_token',
  RTDN_FAILED: 'subscription.rtdn.failed',
  // Reconciliation / sweeps
  RECONCILE_STARTED: 'subscription.reconcile.started',
  RECONCILE_COMPLETED: 'subscription.reconcile.completed',
  RECONCILE_ITEM_FAILED: 'subscription.reconcile.item_failed',
  // Google Play Developer API
  GOOGLE_API_CALL: 'subscription.google_api.call',
} as const;

export type SubEventName = (typeof SUB_EVENT)[keyof typeof SUB_EVENT];

/** Coarse, low-cardinality error classes for dashboards + alert routing. */
export const ERROR_CLASS = {
  INVALID_TOKEN: 'invalid_token',
  UNKNOWN_PRODUCT: 'unknown_product',
  OWNERSHIP_CONFLICT: 'ownership_conflict',
  NOT_CONFIGURED: 'not_configured',
  GOOGLE_API: 'google_api',
  UNATTRIBUTABLE: 'unattributable',
  UNEXPECTED: 'unexpected',
} as const;

export type ErrorClass = (typeof ERROR_CLASS)[keyof typeof ERROR_CLASS];

/** Raw (unredacted) inputs a caller has on hand at an instrumentation point. */
export interface SubContextInput {
  userId?: string | null;
  /** Raw purchase token — HASHED here, never logged in the clear. */
  purchaseToken?: string | null;
  productId?: string | null;
  /** Raw order id — HASHED here. */
  orderId?: string | null;
  subscriptionState?: string | null;
  acknowledged?: boolean;
  /** Raw linked token — reduced to a boolean presence flag. */
  linkedPurchaseToken?: string | null;
  /** Attempt number (1-based) for retried operations (verify / ack). */
  attempt?: number;
  /** AuditSource-style origin: 'client' | 'rtdn' | 'system'. */
  source?: string;
  latencyMs?: number;
  outcome?: string;
  errorClass?: ErrorClass;
  /** Any additional low-cardinality, non-sensitive fields. */
  extra?: Record<string, string | number | boolean | null | undefined>;
}

/** Fully-redacted, correlation-stamped context object for a subscription log line. */
export interface SubLogContext {
  evt: 'subscription';
  correlationId?: string;
  userId?: string | null;
  purchaseTokenHash: string | null;
  productId?: string | null;
  orderIdHash: string | null;
  subscriptionState?: string | null;
  acknowledged?: boolean;
  linkedPurchaseTokenPresent?: boolean;
  attempt?: number;
  source?: string;
  latencyMs?: number;
  outcome?: string;
  errorClass?: ErrorClass;
  [k: string]: unknown;
}

/**
 * Build a redacted, correlation-stamped context object from raw inputs. Tokens
 * and order ids are hashed; the linked token becomes a presence boolean; the
 * ambient correlation id is injected. Pure + deterministic (aside from the
 * ambient correlation read) so it is directly unit-testable.
 */
export function buildContext(input: SubContextInput): SubLogContext {
  const ctx: SubLogContext = {
    evt: 'subscription',
    correlationId: getCorrelationId(),
    purchaseTokenHash: hashPurchaseToken(input.purchaseToken),
    orderIdHash: hashOrderId(input.orderId),
  };
  if (input.userId !== undefined) ctx.userId = input.userId;
  if (input.productId !== undefined) ctx.productId = input.productId;
  if (input.subscriptionState !== undefined) ctx.subscriptionState = input.subscriptionState;
  if (input.acknowledged !== undefined) ctx.acknowledged = input.acknowledged;
  if (input.linkedPurchaseToken !== undefined) {
    ctx.linkedPurchaseTokenPresent = linkedTokenPresent(input.linkedPurchaseToken);
  }
  if (input.attempt !== undefined) ctx.attempt = input.attempt;
  if (input.source !== undefined) ctx.source = input.source;
  if (input.latencyMs !== undefined) ctx.latencyMs = input.latencyMs;
  if (input.outcome !== undefined) ctx.outcome = input.outcome;
  if (input.errorClass !== undefined) ctx.errorClass = input.errorClass;
  if (input.extra) Object.assign(ctx, input.extra);
  return ctx;
}
