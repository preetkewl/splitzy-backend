import type { RequestHandler } from 'express';
import { newCorrelationId, runWithCorrelation } from './correlation.js';

/**
 * Establishes the ambient correlation id for a subscription HTTP request so
 * every downstream log line (verify → grant → ack …) carries it without any
 * service signature change. Reuses the request's existing `requestId` (set by
 * the global `requestId` middleware and echoed on `X-Request-Id`) as the
 * correlation id, so frontend ↔ backend traces line up; falls back to a fresh
 * id when none is present (e.g. test harnesses).
 *
 * Mount directly on the subscription router, after `requestId`.
 */
export const correlationMiddleware: RequestHandler = (req, _res, next) => {
  const correlationId = req.requestId ?? newCorrelationId('sub');
  runWithCorrelation(correlationId, () => next());
};
