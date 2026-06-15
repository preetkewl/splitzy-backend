/**
 * Acknowledgment recovery sweep.
 *
 * Google auto-refunds a subscription purchase that is not acknowledged within 3
 * days. The verify/RTDN paths acknowledge inline, but that network call can
 * fail — this sweep re-processes any still-unacknowledged entitling purchase so
 * the ack converges. Idempotent and safe to run frequently (e.g. hourly).
 *
 * Run from cron:
 *   npx tsx scripts/ack-purchases.ts [--limit=200]
 */
import { createEntitlementModule } from '../src/modules/entitlement/index.js';
import { disconnectDatabase } from '../src/database/prisma.js';
import { logger } from '../src/utils/logger.js';

function parseLimit(): number {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--limit='));
  if (!arg) return 200;
  const n = Number(arg.slice('--limit='.length));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid --limit: ${arg}`);
  return Math.floor(n);
}

async function main(): Promise<void> {
  const limit = parseLimit();
  const { reconciliation } = createEntitlementModule();
  const summary = await reconciliation.runAcknowledgementSweep(limit);
  logger.info({ ...summary }, 'acknowledgment sweep finished');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'acknowledgment sweep failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectDatabase();
  });
