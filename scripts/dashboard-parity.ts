/**
 * Parity test: the dashboard's scalar `BalanceEngine.userNet(...)` MUST equal
 * the canonical `BalanceEngine.computeNetBalances(...)[user].netMinor` that
 * `/balances` uses — for the same data. This is the guarantee that dashboard
 * math and trip-detail math cannot drift.
 *
 * Pure engine test (no DB): generates random-but-valid expense/settlement sets,
 * computes net both ways for every user, and asserts equality + SUM === 0.
 *
 * Run: npm run smoke:dashboard
 */
import {
  BalanceEngine,
  type ExpenseInput,
  type SettlementTransfer,
} from '../src/modules/expense/engine/balance-engine.js';

type Rng = () => number;

/** Deterministic LCG so failures are reproducible from the printed seed. */
function lcg(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const pick = (rng: Rng, n: number) => Math.floor(rng() * n);
const between = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

function buildCase(rng: Rng) {
  const userCount = between(rng, 2, 6);
  const userIds = Array.from({ length: userCount }, (_, i) => `u${String(i)}`);

  const expenses: ExpenseInput[] = [];
  const expenseCount = between(rng, 0, 12);
  for (let i = 0; i < expenseCount; i++) {
    const amountMinor = between(rng, 1, 500_000);
    // Random non-empty participant subset.
    const participantIds = userIds.filter(() => rng() < 0.6);
    if (participantIds.length === 0) participantIds.push(userIds[pick(rng, userCount)]!);
    const payerId = participantIds[pick(rng, participantIds.length)]!;
    const participants = BalanceEngine.splitEqual(amountMinor, participantIds, payerId);
    // Single payer covers the whole amount (Phase 2 shape).
    expenses.push({ amountMinor, payments: [{ userId: payerId, contributionMinor: amountMinor }], participants });
  }

  const settlements: SettlementTransfer[] = [];
  const settlementCount = between(rng, 0, 6);
  for (let i = 0; i < settlementCount; i++) {
    const from = pick(rng, userCount);
    let to = pick(rng, userCount);
    if (from === to) to = (to + 1) % userCount;
    settlements.push({
      fromUserId: userIds[from]!,
      toUserId: userIds[to]!,
      amountMinor: between(rng, 1, 100_000),
    });
  }
  return { userIds, expenses, settlements };
}

/** The scalar aggregates the dashboard SQL produces, computed here in-memory. */
function viewerTotals(userId: string, expenses: ExpenseInput[], settlements: SettlementTransfer[]) {
  let paidMinor = 0;
  let shareMinor = 0;
  let settledOutMinor = 0;
  let settledInMinor = 0;
  for (const e of expenses) {
    for (const p of e.payments) if (p.userId === userId) paidMinor += p.contributionMinor;
    for (const p of e.participants) if (p.userId === userId) shareMinor += p.shareMinor;
  }
  for (const s of settlements) {
    if (s.fromUserId === userId) settledOutMinor += s.amountMinor;
    if (s.toUserId === userId) settledInMinor += s.amountMinor;
  }
  return { paidMinor, shareMinor, settledOutMinor, settledInMinor };
}

function main() {
  const CASES = 2000;
  let checks = 0;
  for (let c = 0; c < CASES; c++) {
    const seed = 0x9e3779b9 ^ c;
    const rng = lcg(seed);
    const { userIds, expenses, settlements } = buildCase(rng);

    const matrix = BalanceEngine.computeNetBalances(userIds, expenses, settlements);
    const matrixByUser = new Map(matrix.map((b) => [b.userId, b.netMinor]));

    // Invariant: full matrix sums to zero.
    const sum = matrix.reduce((a, b) => a + b.netMinor, 0);
    if (sum !== 0) {
      console.error(`✘ seed=${seed}: SUM(net) = ${String(sum)} ≠ 0`);
      process.exit(1);
    }

    for (const userId of userIds) {
      const scalar = BalanceEngine.userNet(viewerTotals(userId, expenses, settlements));
      const canonical = matrixByUser.get(userId) ?? 0;
      checks++;
      if (scalar !== canonical) {
        console.error(
          `✘ DRIFT seed=${seed} user=${userId}: userNet=${String(scalar)} ≠ computeNetBalances=${String(canonical)}`,
        );
        process.exit(1);
      }
    }
  }
  console.log(`✔ dashboard parity: ${String(checks)} user-nets across ${String(CASES)} cases — userNet === computeNetBalances`);
}

main();
