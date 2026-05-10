import express, { type Application } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { env } from './config/env.js';
import { ApiResponse } from './core/api-response.js';
import {
  apiRateLimiter,
  corsMiddleware,
  errorHandler,
  notFoundHandler,
  requestId,
  requestLogger,
} from './middlewares/index.js';
import { createApiRouter } from './routes/index.js';
import './types/index.js';

export function createApp(): Application {
  const app = express();

  // ── Security & infra ───────────────────────────────────────────────────────
  // `trust proxy` so X-Forwarded-* headers are honored (rate-limit, real IP)
  // when running behind a reverse proxy (nginx, ELB, Render, etc.).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(corsMiddleware);
  app.use(compression());

  // ── Body parsing ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ── Observability ─────────────────────────────────────────────────────────
  // requestId comes BEFORE the logger so every emitted line has it.
  // It also runs before rate-limit so rejected requests still get an id.
  app.use(requestId);
  app.use(requestLogger);

  // ── Rate limiting (after logger so denied requests are still logged) ──────
  app.use(env.API_PREFIX, apiRateLimiter);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    ApiResponse.ok(res, {
      name: 'splitzy-backend',
      version: '0.1.0',
      apiPrefix: env.API_PREFIX,
    });
  });

  app.use(env.API_PREFIX, createApiRouter());

  // ── 404 + error handler (must be last) ────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
