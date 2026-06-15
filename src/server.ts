import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { validateMonetizationConfig } from './config/startup-validation.js';
import { connectDatabase, disconnectDatabase } from './database/prisma.js';
import { logger } from './utils/logger.js';

async function bootstrap(): Promise<void> {
  // Fail fast if monetization is required but misconfigured (before accepting
  // traffic). Logs a readiness diagnostic either way.
  validateMonetizationConfig();

  await connectDatabase();

  const app = createApp();
  const server: Server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, apiPrefix: env.API_PREFIX },
      `🚀 splitzy-backend listening on http://localhost:${env.PORT}${env.API_PREFIX}`,
    );
  });

  registerShutdown(server);
}

function registerShutdown(server: Server): void {
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown signal received');
    server.close(async (err) => {
      if (err) {
        logger.error({ err }, 'error closing http server');
        process.exit(1);
      }
      try {
        await disconnectDatabase();
        process.exit(0);
      } catch (e) {
        logger.error({ err: e }, 'error disconnecting database');
        process.exit(1);
      }
    });
    // Force-exit if the graceful path stalls.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled rejection');
    process.exit(1);
  });
}

bootstrap().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to bootstrap server');
  process.exit(1);
});
