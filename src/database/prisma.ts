import { PrismaClient } from '@prisma/client';
import { env, isProd } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Prisma singleton.
 *
 * In development, `tsx watch` re-executes this module on every change.
 * Without the global cache, each reload would create a fresh PrismaClient
 * and exhaust the database connection pool. The `globalThis` cache keeps
 * a single instance across hot reloads.
 *
 * In production, `globalForPrisma` is never read — a fresh client is
 * created once at startup.
 */
type GlobalWithPrisma = typeof globalThis & {
  __prisma__?: PrismaClient;
};

const globalForPrisma = globalThis as GlobalWithPrisma;

export const prisma: PrismaClient =
  globalForPrisma.__prisma__ ??
  new PrismaClient({
    log: isProd ? ['error'] : ['query', 'warn', 'error'],
  });

if (!isProd) {
  globalForPrisma.__prisma__ = prisma;
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info({ url: redactDbUrl(env.DATABASE_URL) }, 'database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('database disconnected');
}

function redactDbUrl(url: string): string {
  return url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}
