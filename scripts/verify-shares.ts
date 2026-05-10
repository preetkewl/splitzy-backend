/**
 * Regression test for backend math vs. the Flutter `balances.dart`.
 *
 * Two assertions per fixture:
 *   1. backend `computeNetBalances` produces the same per-user net as
 *      the frontend `computeNet` (for amounts cleanly divisible by n —
 *      the frontend's algorithm drifts on remainders, ours doesn't).
 *   2. backend `simplify` produces the same transfer list as the
 *      frontend `simplifyDebts` for the same input.
 *
 * Run with:  npx tsx scripts/verify-shares.ts
 */
import { BalanceEngine } from '../src/modules/expense/engine/balance-engine.js';
import type {
  ExpenseInput,
  NetBalance,
  SettlementTransfer,
} from '../src/modules/expense/engine/balance-engine.js';

interface SeedExpense {
  amount: number;
  payer: string;
}

const memberIds = ['aarya', 'aarav', 'meera', 'kabir'] as const;

const seedExpenses: SeedExpense[] = [
  { amount: 1_240_000, payer: 'aarav' },
  { amount:    80_000, payer: 'aarya' },
  { amount:   460_000, payer: 'meera' },
  { amount:   184_000, payer: 'kabir' },
  { amount:   320_000, payer: 'aarya' },
  { amount:   240_000, payer: 'aarav' },
];

// ──────────────────────────────────────────────────────────────────────────────
// Frontend algorithms (mirrored verbatim from splitzy/lib/services/balances.dart)
// ──────────────────────────────────────────────────────────────────────────────

function frontendComputeNet(): Map<string, number> {
  const net = new Map<string, number>(memberIds.map((id) => [id, 0]));
  const count = memberIds.length;
  for (const e of seedExpenses) {
    const share = Math.floor(e.amount / count);
    for (const id of memberIds) net.set(id, (net.get(id) ?? 0) - share);
    net.set(e.payer, (net.get(e.payer) ?? 0) + e.amount);
  }
  return net;
}

interface FrontendTransfer {
  from: string;
  to: string;
  amount: number;
}

function frontendSimplify(net: Map<string, number>): FrontendTransfer[] {
  const creditors = Array.from(net.entries())
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);
  const debtors = Array.from(net.entries())
    .filter(([, v]) => v < 0)
    .sort(([, a], [, b]) => a - b);
  const cAmts = creditors.map(([, v]) => v);
  const dAmts = debtors.map(([, v]) => Math.abs(v));

  const transfers: FrontendTransfer[] = [];
  let i = 0;
  let j = 0;
  while (i < dAmts.length && j < cAmts.length) {
    const dAmt = dAmts[i] ?? 0;
    const cAmt = cAmts[j] ?? 0;
    const pay = dAmt < cAmt ? dAmt : cAmt;
    if (pay > 0) {
      transfers.push({
        from: debtors[i]?.[0] ?? '',
        to: creditors[j]?.[0] ?? '',
        amount: pay,
      });
    }
    dAmts[i] = dAmt - pay;
    cAmts[j] = cAmt - pay;
    if (dAmts[i] === 0) i += 1;
    if (cAmts[j] === 0) j += 1;
  }
  return transfers;
}

// ──────────────────────────────────────────────────────────────────────────────
// Backend algorithms via the engine
// ──────────────────────────────────────────────────────────────────────────────

function backendNet(): NetBalance[] {
  const expenses: ExpenseInput[] = seedExpenses.map((e) => ({
    payerId: e.payer,
    amountPaise: e.amount,
    participants: BalanceEngine.splitEqual(e.amount, [...memberIds], e.payer),
  }));
  return BalanceEngine.computeNetBalances([...memberIds], expenses);
}

function backendTransfers(net: NetBalance[]): SettlementTransfer[] {
  return BalanceEngine.simplify(net);
}

// ──────────────────────────────────────────────────────────────────────────────

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✘ ${name}`);
    if (detail !== undefined) console.error('    ', detail);
  }
}

console.log('\n· Goa fixture — net balances match frontend (clean division)');
const fe = frontendComputeNet();
const beRows = backendNet();
const beMap = new Map<string, number>();
for (const r of beRows) beMap.set(r.userId, r.netPaise);

for (const id of memberIds) {
  check(
    `net[${id}] matches`,
    fe.get(id) === beMap.get(id),
    { fe: fe.get(id), be: beMap.get(id) },
  );
}
const sumBe = beRows.reduce((s, r) => s + r.netPaise, 0);
check('SUM(backend net) === 0', sumBe === 0, { sum: sumBe });

console.log('\n· Goa fixture — simplify matches frontend');
const feTransfers = frontendSimplify(fe);
const beTransfers = backendTransfers(beRows);

check(
  'transfer count matches',
  feTransfers.length === beTransfers.length,
  { fe: feTransfers.length, be: beTransfers.length },
);

// Compare set semantics — both should produce the same {from, to, amount}
// triples. Order may technically differ if there are ties, but the Goa
// fixture has none.
const feKeys = new Set(feTransfers.map((t) => `${t.from}→${t.to}:${String(t.amount)}`));
const beKeys = new Set(beTransfers.map((t) => `${t.fromUserId}→${t.toUserId}:${String(t.amountPaise)}`));
check(
  'transfer set matches frontend',
  feKeys.size === beKeys.size && [...feKeys].every((k) => beKeys.has(k)),
  { fe: feTransfers, be: beTransfers },
);

const sumFeTransfers = feTransfers.reduce((s, t) => s + t.amount, 0);
const sumBeTransfers = beTransfers.reduce((s, t) => s + t.amountPaise, 0);
check(
  'SUM(transfers) matches between frontend and backend',
  sumFeTransfers === sumBeTransfers,
  { fe: sumFeTransfers, be: sumBeTransfers },
);

if (failures > 0) {
  console.error(`\n✘ ${String(failures)} regression(s) failed`);
  process.exit(1);
}
console.log('\n✔ backend math matches frontend on the Goa fixture (net + simplify)');
