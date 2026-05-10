import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodSchema } from 'zod';

export interface RequestSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Generic Zod validator middleware. Replaces `req.body | req.query | req.params`
 * with the parsed value so downstream handlers consume the typed shape.
 *
 * Throws ZodError on failure → caught by central error handler and returned
 * as a structured 422 with field-level messages.
 */
export const validateRequest =
  (schemas: RequestSchemas): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (schemas.body) req.body = schemas.body.parse(req.body) as unknown;
    if (schemas.query) {
      const parsed = schemas.query.parse(req.query) as Record<string, unknown>;
      Object.assign(req.query, parsed);
    }
    if (schemas.params) {
      const parsed = schemas.params.parse(req.params) as Record<string, string>;
      Object.assign(req.params, parsed);
    }
    next();
  };
