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
  ackSuccess: 'monetization.ack.success',
  ackFailure: 'monetization.ack.failure',
  entitlementGranted: 'monetization.entitlement.granted',
  entitlementRevoked: 'monetization.entitlement.revoked',

  // ── Latency histograms (milliseconds; value = a single observation) ──────────
  /** End-to-end `/subscriptions/verify` service latency. */
  verifyLatencyMs: 'monetization.verify.latency_ms',
  /** Google Play acknowledge call latency. */
  ackLatencyMs: 'monetization.ack.latency_ms',
  /** Google Play Developer API call latency (tagged by `op`). */
  googleApiLatencyMs: 'monetization.google_api.latency_ms',
  /** RTDN webhook processing latency. */
  rtdnLatencyMs: 'monetization.rtdn.latency_ms',

  // ── Counters ─────────────────────────────────────────────────────────────────
  /** A Google Play Developer API call outcome (tagged by `op`, `outcome`). */
  googleApiCall: 'monetization.google_api.call',
  /** Cross-account purchase-token ownership conflicts (409s). */
  ownershipConflict: 'monetization.ownership.conflict',
  /** linkedPurchaseToken chain migrations (upgrade/downgrade/resubscribe/replace). */
  linkedMigration: 'monetization.migration.linked',
  /** Acknowledgement retries performed by the ack sweep (value = count reprocessed). */
  ackRetryCount: 'monetization.ack.retry_count',
  /** Retry/ack queue depth after a sweep (gauge; = unacknowledged entitling rows). */
  retryQueueDepth: 'monetization.ack.queue_depth',
  /** Subscriptions expired during a reconcile sweep (value = count). */
  expiredSubscriptions: 'monetization.subscription.expired',
  /** Purchase restore outcome (client re-delivery re-verified; tagged by `outcome`). */
  restoreOutcome: 'monetization.restore.outcome',
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
  /** Dashboard-computed: page if Google API error rate exceeds this over 5m (outage). */
  googleApiErrorRate: 0.2,
  /** Dashboard-computed: warn if ownership-conflict rate exceeds this over 15m (abuse/bug). */
  ownershipConflictRate: 0.02,
  /** Dashboard-computed: page if p95 verify latency exceeds this (ms) over 10m. */
  verifyLatencyP95Ms: 4000,
  /** Dashboard-computed: page if p95 Google API latency exceeds this (ms) over 10m. */
  googleApiLatencyP95Ms: 3000,
} as const;
