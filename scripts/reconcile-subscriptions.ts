/**
 * Subscription reconciliation sweep.
 *
 * RTDN is best-effort (Pub/Sub can drop / delay / dead-letter a message). This
 * sweep re-derives every non-terminal purchase from Google's
 * subscriptionsv2.get and repairs drift — renewals that extended expiry,
 * cancellations, lapses (→ expire), and refunds. Idempotent and bounded; run
 * from cron (e.g. daily).
 *
 * Run:
 *   npx tsx scripts/reconcile-subscriptions.ts [--limit=200]
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
  const summary = await reconciliation.runReconciliationSweep(limit);
  logger.info({ ...summary }, 'reconciliation sweep finished');
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'reconciliation sweep failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectDatabase();
  });
