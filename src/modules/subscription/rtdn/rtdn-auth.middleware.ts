import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { env, isProd } from '../../../config/env.js';
import { ApiError } from '../../../core/api-error.js';
import { logger } from '../../../utils/logger.js';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Guards the RTDN webhook with a shared secret. Configure the Pub/Sub push
 * endpoint with `?token=<RTDN_VERIFICATION_TOKEN>` (or send it as the
 * `x-rtdn-token` header). When the secret is unset the webhook is rejected in
 * production and allowed (with a warning) elsewhere so local/staging testing
 * works without a secret.
 */
export const verifyRtdnToken: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const expected = env.RTDN_VERIFICATION_TOKEN;
  const provided =
    (typeof req.query.token === 'string' ? req.query.token : undefined) ?? req.header('x-rtdn-token') ?? '';

  if (expected) {
    if (!safeEqual(provided, expected)) {
      throw ApiError.unauthorized('Invalid RTDN verification token');
    }
    return next();
  }

  if (isProd) {
    throw ApiError.unauthorized('RTDN webhook is not configured');
  }
  logger.warn('RTDN_VERIFICATION_TOKEN not set — allowing unauthenticated RTDN (non-prod only)');
  return next();
};
