import { logger } from '../../../utils/logger.js';
import { type AlertSeverity, emitAlert, emitMetric, type MetricTags } from '../../../utils/metrics.js';
import { buildContext, type SubContextInput, type SubEventName, type SubLogContext } from './events.js';

/**
 * Subscription telemetry facade — the single entry point for structured logs,
 * metrics, and alerts across the billing lifecycle. It layers on top of the
 * shared `logger` / `emitMetric` / `emitAlert` (so events flow to the real
 * pipeline) while ALSO fanning out to an optional in-memory sink used by tests
 * to assert emission, redaction, and correlation without parsing stdout.
 *
 * This module contains NO business logic: it only records what happened.
 */

export type SubLogLevel = 'info' | 'warn' | 'error';

export type Captured =
  | { kind: 'log'; level: SubLogLevel; event: SubEventName; ctx: SubLogContext }
  | { kind: 'metric'; name: string; value: number; tags: MetricTags }
  | { kind: 'alert'; alert: string; severity: AlertSeverity; detail: MetricTags };

type Sink = (c: Captured) => void;

let sink: Sink | null = null;

/** Install a capture sink (tests only). Returns the collected events + a restore fn. */
export function captureTelemetry(): { events: Captured[]; restore: () => void } {
  const events: Captured[] = [];
  const previous = sink;
  sink = (c) => events.push(c);
  return { events, restore: () => (sink = previous) };
}

/** Emit a structured subscription log line (redacted + correlation-stamped). */
export function subLog(level: SubLogLevel, event: SubEventName, input: SubContextInput = {}): void {
  const ctx = buildContext(input);
  logger[level]({ ...ctx, event }, event);
  sink?.({ kind: 'log', level, event, ctx });
}

/** Emit a subscription metric (log-based; low-cardinality tags only). */
export function subMetric(name: string, value = 1, tags: MetricTags = {}): void {
  emitMetric(name, value, tags);
  sink?.({ kind: 'metric', name, value, tags });
}

/** Emit a subscription operational alert. */
export function subAlert(alert: string, severity: AlertSeverity, detail: MetricTags = {}): void {
  emitAlert(alert, severity, detail);
  sink?.({ kind: 'alert', alert, severity, detail });
}

/** Monotonic start marker for latency measurement. */
export function startTimer(): bigint {
  return process.hrtime.bigint();
}

/** Milliseconds elapsed since a {@link startTimer} marker, rounded to 0.01ms. */
export function elapsedMs(start: bigint): number {
  return Math.round((Number(process.hrtime.bigint() - start) / 1_000_000) * 100) / 100;
}
