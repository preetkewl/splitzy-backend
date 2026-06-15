/**
 * Stable metric names + alert thresholds for the monetization subsystem.
 *
 * Metric names use dotted, low-cardinality identifiers so a log-based exporter
 * (Prometheus textfile / Vector / DataDog log pipeline) can map `evt:"metric"`
 * lines onto time series. Keep tags low-cardinality (no userIds/tokens).
 */
export const METRICS = {
  verifySuccess: 'monetization.verify.success',
  verifyFailure: 'monetization.verify.failure',
  rtdnProcessed: 'monetization.rtdn.processed',
  rtdnDuplicate: 'monetization.rtdn.duplicate',
  rtdnIgnored: 'monetization.rtdn.ignored',
  rtdnFailure: 'monetization.rtdn.failure',
  reconcileScanned: 'monetization.reconcile.scanned',
  reconcileReconciled: 'monetization.reconcile.reconciled',
  reconcileExpired: 'monetization.reconcile.expired',
  reconcileFailed: 'monetization.reconcile.failed',
  ackBacklog: 'monetization.ack.backlog',
  entitlementGranted: 'monetization.entitlement.granted',
  entitlementRevoked: 'monetization.entitlement.revoked',
} as const;

/**
 * Operational alert thresholds. The code emits structured `evt:"alert"` events
 * when a sweep crosses one of these; wire your alerting platform to page on the
 * `alert` field. Rate-based thresholds (verify/RTDN failure rate) are computed
 * at the dashboard layer from the counters above — documented here for the
 * runbook, not enforced in code.
 */
export const ALERT_THRESHOLDS = {
  /** Any unacknowledged entitling purchase remaining after an ack sweep. */
  ackBacklog: 1,
  /** Any per-item failures within a reconciliation/ack sweep. */
  sweepFailed: 1,
  /** Dashboard-computed: page if RTDN 5xx rate exceeds this over 5m. */
  rtdnFailureRate: 0.05,
  /** Dashboard-computed: page if verify failure rate exceeds this over 15m. */
  verifyFailureRate: 0.1,
  /** Dashboard-computed: page if the Pub/Sub dead-letter topic is non-empty. */
  deadLetterDepth: 1,
} as const;
