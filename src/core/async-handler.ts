import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route/controller so any rejected promise is forwarded to
 * Express's `next()` and picked up by the central error handler. Without
 * this, an `await` that throws inside an async handler crashes the process.
 */
export type AsyncRequestHandler<
  P = Record<string, string>,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Record<string, string | string[] | undefined>,
> = (
  req: Request<P, ResBody, ReqBody, ReqQuery>,
  res: Response<ResBody>,
  next: NextFunction,
) => Promise<unknown>;

export const asyncHandler =
  <P, ResBody, ReqBody, ReqQuery>(
    fn: AsyncRequestHandler<P, ResBody, ReqBody, ReqQuery>,
  ): RequestHandler<P, ResBody, ReqBody, ReqQuery> =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
