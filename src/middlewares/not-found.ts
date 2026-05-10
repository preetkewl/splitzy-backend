import type { RequestHandler } from 'express';
import { ApiError } from '../core/api-error.js';

/**
 * Catches any request that doesn't match a registered route and forwards
 * a 404 to the central error handler. Mount AFTER all real routes,
 * BEFORE the error-handler middleware.
 */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};
