import type { RequestHandler } from 'express';
import { logger } from '../utils/logger.js';

/**
 * Structured per-request logger.
 *
 * Emits exactly one log line per request, on `res.finish`, carrying:
 *   - method, originalUrl, status, durationMs
 *   - requestId (set by the requestId middleware; falls back to undefined)
 *   - userId   (set by `requireAuth`; absent on unauth'd routes)
 *
 * Replaces morgan: morgan emits a flat string that's expensive for log
 * aggregators to parse. Pino + JSON is what production wants.
 *
 * Sensitive fields (Authorization header, body, query) are intentionally
 * not logged here — Pino's `redact` rules cover anything we attach
 * elsewhere as a defense-in-depth.
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedNs = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedNs = process.hrtime.bigint() - startedNs;
    const durationMs = Math.round((Number(elapsedNs) / 1_000_000) * 100) / 100;

    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](
      {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs,
        userId: req.user?.id,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      },
      'request',
    );
  });

  next();
};
