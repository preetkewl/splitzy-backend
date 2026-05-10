import { ERROR_CODES, type ErrorCode } from '../constants/error-codes.js';
import { HTTP, type HttpStatus } from '../constants/http.js';

export interface ApiErrorDetails {
  /** Field-level validation errors, keyed by path. */
  fields?: Record<string, string[]>;
  /** Free-form structured context for debugging. */
  meta?: Record<string, unknown>;
}

/**
 * Application error type.
 *
 * Anything thrown that is *not* an ApiError is treated as an unexpected
 * 500 by the error-handler middleware. Use this class for any error you
 * want to reach the client with a specific status / code / message.
 */
export class ApiError extends Error {
  public readonly statusCode: HttpStatus;
  public readonly code: ErrorCode;
  public readonly details?: ApiErrorDetails;
  public readonly isOperational: boolean;

  constructor(
    statusCode: HttpStatus,
    code: ErrorCode,
    message: string,
    details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = 'Bad request', details?: ApiErrorDetails): ApiError {
    return new ApiError(HTTP.BAD_REQUEST, ERROR_CODES.BAD_REQUEST, message, details);
  }

  static validation(message = 'Validation failed', details?: ApiErrorDetails): ApiError {
    return new ApiError(HTTP.UNPROCESSABLE_ENTITY, ERROR_CODES.VALIDATION_FAILED, message, details);
  }

  static unauthorized(message = 'Unauthorized'): ApiError {
    return new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.UNAUTHORIZED, message);
  }

  static forbidden(message = 'Forbidden'): ApiError {
    return new ApiError(HTTP.FORBIDDEN, ERROR_CODES.FORBIDDEN, message);
  }

  static notFound(message = 'Not found'): ApiError {
    return new ApiError(HTTP.NOT_FOUND, ERROR_CODES.NOT_FOUND, message);
  }

  static conflict(message = 'Conflict'): ApiError {
    return new ApiError(HTTP.CONFLICT, ERROR_CODES.CONFLICT, message);
  }

  static tooMany(message = 'Too many requests'): ApiError {
    return new ApiError(HTTP.TOO_MANY_REQUESTS, ERROR_CODES.RATE_LIMITED, message);
  }

  static internal(message = 'Internal server error'): ApiError {
    return new ApiError(HTTP.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, message);
  }
}
