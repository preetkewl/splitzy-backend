import cors, { type CorsOptions } from 'cors';
import type { RequestHandler } from 'express';
import { env } from '../config/env.js';

function parseOrigins(raw: string): string[] | '*' {
  const trimmed = raw.trim();
  if (trimmed === '*' || trimmed === '') return '*';
  return trimmed
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

const origins = parseOrigins(env.CORS_ORIGINS);

const corsOptions: CorsOptions = {
  origin:
    origins === '*'
      ? true
      : (incoming, cb) => {
          if (!incoming || origins.includes(incoming)) cb(null, true);
          else cb(new Error(`Origin not allowed by CORS: ${incoming}`));
        },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  exposedHeaders: ['RateLimit', 'RateLimit-Policy', 'Retry-After'],
  maxAge: 86_400,
};

export const corsMiddleware: RequestHandler = cors(corsOptions);
