/**
 * Operational cleanup: drop refresh tokens that are past their expiry
 * AND haven't been used in a configurable grace window.
 *
 * The auth flow already treats expired/revoked tokens as invalid at
 * read time, so this is purely housekeeping — the table doesn't grow
 * unbounded and DB backups stay tight.
 *
 * Run from cron (e.g. nightly):
 *   npx tsx scripts/cleanup-expired-tokens.ts [--days=30] [--dry]
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../src/utils/logger.js';

interface Args {
  days: number;
  dry: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { days: 30, dry: false };
  for (const a of argv) {
    if (a === '--dry') out.dry = true;
    else if (a.startsWith('--days=')) {
      const n = Number(a.slice('--days='.length));
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`invalid --days value: ${a}`);
      }
      out.days = Math.floor(n);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const prisma = new PrismaClient();

  // Cutoff: rows that have been useless for >= `days` days.
  const cutoff = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);

  const where = {
    OR: [
      { revokedAt: { lt: cutoff } },
      { expiresAt: { lt: cutoff } },
    ],
  };

  const candidates = await prisma.refreshToken.count({ where });
  logger.info({ candidates, cutoff: cutoff.toISOString(), dry: args.dry }, 'cleanup-tokens: scan');

  if (args.dry) {
    logger.info('cleanup-tokens: --dry passed, nothing deleted');
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.refreshToken.deleteMany({ where });
  logger.info({ deleted: result.count }, 'cleanup-tokens: done');
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'cleanup-tokens: failed');
  process.exit(1);
});
