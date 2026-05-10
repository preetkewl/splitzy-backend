import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../config/env.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { HTTP } from '../constants/http.js';

const baseOptions: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
};

/**
 * Default rate limiter applied to the entire API surface.
 * Tune per-route by mounting a stricter limiter (e.g. on auth endpoints).
 */
export const apiRateLimiter = rateLimit({
  ...baseOptions,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
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
