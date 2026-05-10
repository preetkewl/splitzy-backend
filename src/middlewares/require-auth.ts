import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../core/api-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { HTTP } from '../constants/http.js';
import type { TokenService } from '../modules/auth/service/token.service.js';

/**
 * Reads `Authorization: Bearer <jwt>` and verifies the access token.
 * On success, sets `req.user = { id }`. On failure, throws an ApiError
 * which the central error handler translates to a 401.
 */
export function requireAuth(tokens: TokenService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (token === null) {
      return next(
        new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.UNAUTHORIZED, 'Missing authorization header'),
      );
    }
    try {
      const payload = tokens.verifyAccessToken(token);
      req.user = { id: payload.sub };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Same as `requireAuth` but never errors — sets `req.user` if a valid
 * token was present, otherwise leaves it undefined. Useful for endpoints
 * whose response shape changes when authenticated.
 */
export function optionalAuth(tokens: TokenService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (token === null) return next();
    try {
      const payload = tokens.verifyAccessToken(token);
      req.user = { id: payload.sub };
    } catch {
      // Swallow — caller doesn't require auth.
    }
    next();
  };
}

/** Returns the bearer token string, or null if absent/malformed. */
export function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization') ?? req.header('Authorization');
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null || match[1] === undefined) return null;
  return match[1].trim();
}
