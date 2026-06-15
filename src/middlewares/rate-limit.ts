import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../config/env.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { HTTP } from '../constants/http.js';

const baseOptions: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
};

/**
 * Paths exempt from the per-IP API rate limiter.
 *
 * The RTDN webhook (`/subscriptions/rtdn`) is a server-to-server Pub/Sub push:
 * all deliveries originate from a small pool of Google IPs and can BURST
 * (renewals, retry storms). Per-IP limiting would return 429s that throttle —
 * and under sustained pressure, dead-letter — Google's deliveries. The webhook
 * is independently protected by the shared-secret token middleware and is
 * idempotent + retry-safe, so it is exempt here.
 *
 * When mounted via `app.use(API_PREFIX, apiRateLimiter)`, Express strips the
 * prefix so `req.path` is prefix-relative (e.g. `/subscriptions/rtdn`); we also
 * check `originalUrl` defensively.
 */
export const RATE_LIMIT_EXEMPT_PATHS: readonly string[] = ['/subscriptions/rtdn'];

function isRateLimitExempt(path: string, originalUrl: string): boolean {
  const cleanOriginal = originalUrl.split('?')[0] ?? originalUrl;
  return RATE_LIMIT_EXEMPT_PATHS.some((p) => path === p || cleanOriginal.endsWith(p));
}

/**
 * Default rate limiter applied to the entire API surface.
 * Tune per-route by mounting a stricter limiter (e.g. on auth endpoints).
 */
export const apiRateLimiter = rateLimit({
  ...baseOptions,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  // Never throttle the RTDN webhook — see RATE_LIMIT_EXEMPT_PATHS.
  skip: (req) => isRateLimitExempt(req.path, req.originalUrl),
  message: {
    success: false,
    error: {
      code: ERROR_CODES.RATE_LIMITED,
      message: 'Too many requests, please try again later',
    },
  },
  statusCode: HTTP.TOO_MANY_REQUESTS,
});

/**
 * Stricter limiter for auth surface (login/verify/refresh). Stops
 * brute-force OTP and refresh-token guessing per IP.
 */
export const authRateLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60_000, // 1 minute
  limit: 10,
  message: {
    success: false,
    error: {
      code: ERROR_CODES.RATE_LIMITED,
      message: 'Too many auth attempts, please try again later',
    },
  },
  statusCode: HTTP.TOO_MANY_REQUESTS,
});
