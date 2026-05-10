import type { Response } from 'express';
import { HTTP, type HttpStatus } from '../constants/http.js';
import type { ErrorCode } from '../constants/error-codes.js';

/**
 * Canonical envelope for every JSON response.
 *
 * { success: true,  data: T,                 meta?: ResponseMeta }
 * { success: false, error: { code, message, details? } }
 *
 * The Flutter client decodes from this shape, so changing it is a
 * breaking change to the API contract — bump `/api/v{n}` if you must.
 */
export interface ResponseMeta {
  page?: number;
  pageSize?: number;
  total?: number;
  [k: string]: unknown;
}

export interface SuccessBody<T> {
  success: true;
  data: T;
  meta?: ResponseMeta;
}

export interface ErrorBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export type ApiBody<T> = SuccessBody<T> | ErrorBody;

export class ApiResponse {
  static ok<T>(res: Response, data: T, meta?: ResponseMeta): Response<SuccessBody<T>> {
    return ApiResponse.send(res, HTTP.OK, data, meta);
  }

  static created<T>(res: Response, data: T, meta?: ResponseMeta): Response<SuccessBody<T>> {
    return ApiResponse.send(res, HTTP.CREATED, data, meta);
  }

  static noContent(res: Response): Response {
    return res.status(HTTP.NO_CONTENT).send();
  }

  static send<T>(
    res: Response,
    status: HttpStatus,
    data: T,
    meta?: ResponseMeta,
  ): Response<SuccessBody<T>> {
    const body: SuccessBody<T> = meta ? { success: true, data, meta } : { success: true, data };
    return res.status(status).json(body) as Response<SuccessBody<T>>;
  }

  static error(
    res: Response,
    status: HttpStatus,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ): Response<ErrorBody> {
    const body: ErrorBody =
      details === undefined
        ? { success: false, error: { code, message } }
        : { success: false, error: { code, message, details } };
    return res.status(status).json(body) as Response<ErrorBody>;
  }
}
