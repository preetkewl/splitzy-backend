import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const HEADER = 'x-request-id';

/**
 * Accept upstream `X-Request-Id` only if it's a sane shape — letters,
 * digits, underscore, hyphen; max 64 chars. Anything else is replaced
 * with a server-generated UUID. Prevents log-injection via a malicious
 * header (e.g. embedded newlines) while still letting load balancers
 * and clients propagate their own correlation ids.
 */
const SAFE_SHAPE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Sets `req.requestId` (a UUID) and echoes it on the response's
 * `X-Request-Id` header. Mount before any logger or error handler so
 * every downstream log line can carry the correlation id.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header(HEADER);
  const id = incoming !== undefined && SAFE_SHAPE.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader(HEADER, id);
  next();
};
