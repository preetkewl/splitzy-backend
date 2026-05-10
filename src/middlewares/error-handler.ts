import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { ApiError } from '../core/api-error.js';
import { ApiResponse } from '../core/api-response.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { HTTP } from '../constants/http.js';
import { isProd } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Centralized error handler. Mounted last in the middleware chain.
 *
 * Translates known error types (ApiError, ZodError, Prisma errors) into
 * the canonical ApiResponse envelope. Anything unknown becomes a 500
 * with a generic message — internals are never leaked to the client.
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) => {
  // Common log context — requestId is the correlation id set by the
  // `requestId` middleware. Absent in test harnesses; that's fine.
  const ctx = {
    requestId: req.requestId,
    path: req.path,
    method: req.method,
    userId: req.user?.id,
  };

  if (err instanceof ApiError) {
    logger.warn(
      { ...ctx, code: err.code, status: err.statusCode },
      err.message,
    );
    return ApiResponse.error(res, err.statusCode, err.code, err.message, err.details);
  }

  if (err instanceof ZodError) {
    const fields: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      (fields[key] ??= []).push(issue.message);
    }
    logger.warn({ ...ctx, fields }, 'validation failed');
    return ApiResponse.error(
      res,
      HTTP.UNPROCESSABLE_ENTITY,
      ERROR_CODES.VALIDATION_FAILED,
      'Validation failed',
      { fields },
    );
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return handlePrismaKnown(err, ctx, res);
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    logger.warn({ ...ctx }, err.message);
    return ApiResponse.error(
      res,
      HTTP.BAD_REQUEST,
      ERROR_CODES.BAD_REQUEST,
      'Invalid database query',
    );
  }

  // Unknown error → log with stack, return generic 500. Stack stays in
  // the log; never echoed to the client (which gets a generic message
  // in production, the raw message in dev).
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error(
    { ...ctx, err: { message: error.message, stack: error.stack } },
    'unhandled error',
  );

  return ApiResponse.error(
    res,
    HTTP.INTERNAL_SERVER_ERROR,
    ERROR_CODES.INTERNAL_ERROR,
    isProd ? 'Internal server error' : error.message,
  );
};

interface ErrorLogContext {
  requestId: string | undefined;
  path: string;
  method: string;
  userId: string | undefined;
}

function handlePrismaKnown(
  err: Prisma.PrismaClientKnownRequestError,
  ctx: ErrorLogContext,
  res: Response,
): Response {
  switch (err.code) {
    case 'P2002': {
      const target = (err.meta?.['target'] as string[] | undefined) ?? [];
      logger.warn({ ...ctx, target }, 'unique constraint violation');
      return ApiResponse.error(
        res,
        HTTP.CONFLICT,
        ERROR_CODES.CONFLICT,
        'A record with these values already exists',
        { fields: target },
      );
    }
    case 'P2025':
      return ApiResponse.error(res, HTTP.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Resource not found');
    default:
      logger.error({ ...ctx, code: err.code }, err.message);
      return ApiResponse.error(
        res,
        HTTP.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR,
        isProd ? 'Internal server error' : err.message,
      );
  }
}
