/**
 * Subscription observability toolkit — structured logging, metrics, tracing
 * (correlation), redaction, and alert hooks for the Google Play billing
 * lifecycle. Instrumentation only; imports no business logic and changes none.
 */
export {
  hashOrderId,
  hashPurchaseToken,
  linkedTokenPresent,
} from './redaction.js';
export {
  getCorrelationId,
  newCorrelationId,
  runWithCorrelation,
} from './correlation.js';
export {
  buildContext,
  ERROR_CLASS,
  SUB_EVENT,
  type ErrorClass,
  type SubContextInput,
  type SubEventName,
  type SubLogContext,
} from './events.js';
export {
  captureTelemetry,
  type Captured,
  elapsedMs,
  startTimer,
  subAlert,
  subLog,
  subMetric,
  type SubLogLevel,
} from './telemetry.js';
export { correlationMiddleware } from './correlation.middleware.js';
