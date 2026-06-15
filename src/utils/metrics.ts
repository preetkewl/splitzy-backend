import { logger } from './logger.js';

/** Low-cardinality dimensions only — never userIds, tokens, or free text. */
export type MetricTags = Record<string, string | number | boolean | undefined>;

/**
 * Emit a single structured metric line. Intentionally log-based (zero extra
 * infra): a shipper matches `evt:"metric"` and forwards `{metric,value,...tags}`
 * to Prometheus/DataDog. Swap this body for a real client later without
 * touching call sites.
 */
export function emitMetric(metric: string, value: number, tags: MetricTags = {}): void {
  logger.info({ evt: 'metric', metric, value, ...tags }, `metric ${metric}`);
}

/** Convenience for a +1 counter. */
export function incMetric(metric: string, tags: MetricTags = {}): void {
  emitMetric(metric, 1, tags);
}

export type AlertSeverity = 'warning' | 'critical';

/**
 * Emit a structured operational alert. Logged at warn/error so existing log
 * routing surfaces it; alerting platforms page on `evt:"alert"` + `severity`.
 */
export function emitAlert(alert: string, severity: AlertSeverity, detail: MetricTags = {}): void {
  const payload = { evt: 'alert', alert, severity, ...detail };
  if (severity === 'critical') {
    logger.error(payload, `alert ${alert}`);
  } else {
    logger.warn(payload, `alert ${alert}`);
  }
}
