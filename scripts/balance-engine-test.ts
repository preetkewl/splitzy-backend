/**
 * Unit tests for the BalanceEngine.
 *
 * Covers the explicit math guarantees from Step 4:
 *   - splitEqual:         SUM(shares) === amount, payer absorbs remainder
 *   - splitEqual:         rejects malformed input (non-positive amount,
 *                          empty list, payer not in participants)
 *   - computeNetBalances: SUM(net) === 0
 *   - computeNetBalances: rejects expenses whose stored shares drift
 *                          from amount (DB-level integrity check)
 *   - simplify:           greedy minimum-transfer; deterministic for
 *                          identical inputs; stable tie-breaks by userId
 *   - simplify:           empty input → empty output; all-settled input
 *                          → empty output
 */
import { BalanceEngine } from '../src/modules/expense/engine/balance-engine.js';
import type { ExpenseInput, NetBalance } from '../src/modules/expense/engine/balance-engine.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✘ ${name}`);
    if (detail !== undefined) console.error('    ', detail);
  }
}
function expectThrow(name: string, fn: () => unknown): void {
  try {
    fn();
    failures += 1;
    console.error(`  ✘ ${name} (expected throw, got success)`);
  } catch {
    console.log(`  ✓ ${name}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// splitEqual
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· splitEqual');

{
  // Clean division: ₹1000 / 4 = ₹250 each
  const shares = BalanceEngine.splitEqual(100_000, ['a', 'b', 'c', 'd'], 'a');
  check(
    'clean division: every share is the same',
    shares.every((s) => s.shareMinor === 25_000),
    shares,
  );
  check(
    'clean division: SUM(shares) === amount',
    shares.reduce((s, x) => s + x.shareMinor, 0) === 100_000,
  );
}

{
  // Remainder: ₹100 / 3 = floor 33, payer absorbs +1
  const shares = BalanceEngine.splitEqual(100, ['a', 'b', 'c'], 'b');
  const sum = shares.reduce((s, x) => s + x.shareMinor, 0);
  check('remainder: SUM(shares) === amount', sum === 100, shares);
  check(
    'remainder: payer absorbs remainder',
    shares.find((x) => x.userId === 'b')?.shareMinor === 34,
    shares,
  );
  check(
    'remainder: non-payers get floor',
    shares.find((x) => x.userId === 'a')?.shareMinor === 33 &&
      shares.find((x) => x.userId === 'c')?.shareMinor === 33,
  );
}

{
  // Single participant (degenerate but legal)
  const shares = BalanceEngine.splitEqual(123, ['a'], 'a');
  check('single participant: payer takes everything', shares.length === 1 && shares[0]?.shareMinor === 123);
}

{
  // Large amount: ₹1 crore split among 7 — the kind of input where 32-bit
  // ranges still fit but the math has to handle non-trivial remainders.
  const amount = 100_000_000_000; // ₹100 crore in minor units — at the bound
  const ids = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];
  const shares = BalanceEngine.splitEqual(amount, ids, 'u3');
  const sum = shares.reduce((s, x) => s + x.shareMinor, 0);
  check('large amount: SUM(shares) === amount', sum === amount);
  check(
    'large amount: payer share = amount − floor*(n−1)',
    shares.find((x) => x.userId === 'u3')?.shareMinor === amount - Math.floor(amount / 7) * 6,
  );
}

console.log('\n· splitEqual rejects malformed input');
expectThrow('zero amount', () => BalanceEngine.splitEqual(0, ['a'], 'a'));
expectThrow('negative amount', () => BalanceEngine.splitEqual(-1, ['a'], 'a'));
expectThrow('non-integer amount', () => BalanceEngine.splitEqual(1.5, ['a'], 'a'));
expectThrow('empty participants', () => BalanceEngine.splitEqual(100, [], 'a'));
expectThrow('payer not in participants', () =>
  BalanceEngine.splitEqual(100, ['a', 'b'], 'c'),
);

// ──────────────────────────────────────────────────────────────────────────────
// computeNetBalances
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· computeNetBalances');

{
  const memberIds = ['a', 'b', 'c'];
  const expenses: ExpenseInput[] = [
    {
      payerId: 'a',
      amountMinor: 30000,
      participants: BalanceEngine.splitEqual(30000, memberIds, 'a'),
    },
    {
      payerId: 'b',
      amountMinor: 9000,
      participants: BalanceEngine.splitEqual(9000, memberIds, 'b'),
    },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  check('clean: returns one row per member', net.length === 3);
  const sum = net.reduce((s, b) => s + b.netMinor, 0);
  check('clean: SUM(net) === 0', sum === 0, net);
  // a: paid 30k; owes 10k (e1) + 3k (e2) = 13k → +17k
  // b: paid  9k; owes 10k (e1) + 3k (e2) = 13k → -4k
  // c: paid  0;  owes 10k (e1) + 3k (e2) = 13k → -13k
  check(
    'a: paid 30k − owes 13k = +17k',
    net.find((b) => b.userId === 'a')?.netMinor === 17_000,
    net,
  );
  check(
    'b: paid  9k − owes 13k = −4k',
    net.find((b) => b.userId === 'b')?.netMinor === -4_000,
    net,
  );
  check(
    'c: paid  0  − owes 13k = −13k',
    net.find((b) => b.userId === 'c')?.netMinor === -13_000,
    net,
  );
}

{
  // Remainder fixture: every expense leaves a 1-minor-unit remainder absorbed
  // by the payer. The frontend's algorithm would drift; ours stays at 0.
  const memberIds = ['a', 'b', 'c'];
  const expenses: ExpenseInput[] = [
    { payerId: 'a', amountMinor: 100, participants: BalanceEngine.splitEqual(100, memberIds, 'a') },
    { payerId: 'b', amountMinor: 100, participants: BalanceEngine.splitEqual(100, memberIds, 'b') },
    { payerId: 'c', amountMinor: 100, participants: BalanceEngine.splitEqual(100, memberIds, 'c') },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  const sum = net.reduce((s, b) => s + b.netMinor, 0);
  check('remainder: SUM(net) === 0 (no drift)', sum === 0, net);
}

{
  // Former-member edge case: an expense participant is no longer a trip member.
  const memberIds = ['a', 'b'];
  const expenses: ExpenseInput[] = [
    {
      payerId: 'x', // 'x' is no longer a member but paid in the past
      amountMinor: 60,
      participants: BalanceEngine.splitEqual(60, ['a', 'b', 'x'], 'x'),
    },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  check('former-member: returns row for x', net.find((b) => b.userId === 'x') !== undefined);
  check(
    'former-member: SUM(net) === 0 still',
    net.reduce((s, b) => s + b.netMinor, 0) === 0,
    net,
  );
  check(
    'former-member: members come first',
    net[0]?.userId === 'a' && net[1]?.userId === 'b' && net[2]?.userId === 'x',
  );
}

console.log('\n· computeNetBalances rejects DB drift');
expectThrow('shares do not sum to amount', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [
    {
      payerId: 'a',
      amountMinor: 100,
      // Shares sum to 99 — caller hand-edited DB. Should throw.
      participants: [
        { userId: 'a', shareMinor: 50 },
        { userId: 'b', shareMinor: 49 },
      ],
    },
  ]),
);

// ──────────────────────────────────────────────────────────────────────────────
// computeNetBalances + settlements (Step 6)
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· computeNetBalances applies completed settlements');

{
  // Setup: a paid 30k for 3 members → a +20k, b -10k, c -10k.
  const memberIds = ['a', 'b', 'c'];
  const expenses: ExpenseInput[] = [
    {
      payerId: 'a',
      amountMinor: 30_000,
      participants: BalanceEngine.splitEqual(30_000, memberIds, 'a'),
    },
  ];

  const noSettlements = BalanceEngine.computeNetBalances(memberIds, expenses);
  check('baseline: a +20k', noSettlements.find((x) => x.userId === 'a')?.netMinor === 20_000);
  check('baseline: b -10k', noSettlements.find((x) => x.userId === 'b')?.netMinor === -10_000);
  check('baseline: c -10k', noSettlements.find((x) => x.userId === 'c')?.netMinor === -10_000);

  // b pays a 10k → b is settled, a still owed 10k by c, c unchanged.
  const partialSettled = BalanceEngine.computeNetBalances(memberIds, expenses, [
    { fromUserId: 'b', toUserId: 'a', amountMinor: 10_000 },
  ]);
  check(
    'partial settlement: b → a 10k zeroes b',
    partialSettled.find((x) => x.userId === 'b')?.netMinor === 0,
    partialSettled,
  );
  check(
    'partial settlement: a drops to +10k',
    partialSettled.find((x) => x.userId === 'a')?.netMinor === 10_000,
  );
  check('partial settlement: c unchanged at -10k', partialSettled.find((x) => x.userId === 'c')?.netMinor === -10_000);
  check(
    'partial settlement: SUM(net) still 0',
    partialSettled.reduce((s, x) => s + x.netMinor, 0) === 0,
  );

  // Both b → a 10k AND c → a 10k → everyone settled at zero.
  const allSettled = BalanceEngine.computeNetBalances(memberIds, expenses, [
    { fromUserId: 'b', toUserId: 'a', amountMinor: 10_000 },
    { fromUserId: 'c', toUserId: 'a', amountMinor: 10_000 },
  ]);
  check(
    'fully settled: every net is 0',
    allSettled.every((x) => x.netMinor === 0),
    allSettled,
  );
  check('fully settled: simplify produces no transfers',
    BalanceEngine.simplify(allSettled).length === 0);

  // Over-payment: b pays a 15k (more than owed). a becomes +5k, b becomes +5k, c -10k.
  // SUM still 0; engine doesn't clamp.
  const overpaid = BalanceEngine.computeNetBalances(memberIds, expenses, [
    { fromUserId: 'b', toUserId: 'a', amountMinor: 15_000 },
  ]);
  check(
    'over-payment: SUM(net) still 0 (engine never clamps)',
    overpaid.reduce((s, x) => s + x.netMinor, 0) === 0,
    overpaid,
  );
  check('over-payment: a drops to +5k', overpaid.find((x) => x.userId === 'a')?.netMinor === 5_000);
  check('over-payment: b flips to +5k', overpaid.find((x) => x.userId === 'b')?.netMinor === 5_000);
}

console.log('\n· computeNetBalances rejects malformed settlements');
expectThrow('settlement with zero amount', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [], [
    { fromUserId: 'a', toUserId: 'b', amountMinor: 0 },
  ]),
);
expectThrow('settlement with negative amount', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [], [
    { fromUserId: 'a', toUserId: 'b', amountMinor: -1 },
  ]),
);
expectThrow('settlement from = to', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [], [
    { fromUserId: 'a', toUserId: 'a', amountMinor: 100 },
  ]),
);

// ──────────────────────────────────────────────────────────────────────────────
// simplify
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· simplify');

{
  const transfers = BalanceEngine.simplify([]);
  check('empty input → empty output', transfers.length === 0);
}

{
  const allSettled: NetBalance[] = [
    { userId: 'a', netMinor: 0 },
    { userId: 'b', netMinor: 0 },
  ];
  check('all-settled → empty', BalanceEngine.simplify(allSettled).length === 0);
}

{
  // Goa-style: 1 creditor, 3 debtors. Should produce 3 transfers.
  const balances: NetBalance[] = [
    { userId: 'aarya', netMinor: -231_000 },
    { userId: 'aarav', netMinor: 849_000 },
    { userId: 'meera', netMinor: -171_000 },
    { userId: 'kabir', netMinor: -447_000 },
  ];
  const t = BalanceEngine.simplify(balances);
  check('Goa: 3 transfers', t.length === 3, t);
  check(
    'Goa: SUM(transfers) === total debt',
    t.reduce((s, x) => s + x.amountMinor, 0) === 849_000,
  );
  // All transfers go to aarav (the only creditor).
  check('Goa: every transfer points at aarav', t.every((x) => x.toUserId === 'aarav'));
  // Order: largest debtor (kabir 447k) first, then aarya 231k, then meera 171k.
  check('Goa: stable order largest debtor first', t[0]?.fromUserId === 'kabir' && t[0]?.amountMinor === 447_000);
  check('Goa: second is aarya 231k', t[1]?.fromUserId === 'aarya' && t[1]?.amountMinor === 231_000);
  check('Goa: third is meera 171k', t[2]?.fromUserId === 'meera' && t[2]?.amountMinor === 171_000);
}

{
  // Determinism — run simplify with permuted input order, expect same output.
  const a: NetBalance[] = [
    { userId: 'u1', netMinor: 100 },
    { userId: 'u2', netMinor: -50 },
    { userId: 'u3', netMinor: -50 },
  ];
  const b: NetBalance[] = [
    { userId: 'u3', netMinor: -50 },
    { userId: 'u1', netMinor: 100 },
    { userId: 'u2', netMinor: -50 },
  ];
  const ta = BalanceEngine.simplify(a);
  const tb = BalanceEngine.simplify(b);
  check(
    'determinism: input order does not change output',
    JSON.stringify(ta) === JSON.stringify(tb),
    { ta, tb },
  );
  check(
    'tie-break: u2 settles first (lex < u3)',
    ta[0]?.fromUserId === 'u2' && ta[1]?.fromUserId === 'u3',
    ta,
  );
}

{
  // Net-zero edge: matched single creditor + single debtor → 1 transfer.
  const t = BalanceEngine.simplify([
    { userId: 'a', netMinor: 1234 },
    { userId: 'b', netMinor: -1234 },
  ]);
  check('single pair: 1 transfer', t.length === 1);
  check(
    'single pair: b → a, 1234',
    t[0]?.fromUserId === 'b' && t[0]?.toUserId === 'a' && t[0]?.amountMinor === 1234,
  );
}

{
  // Many-to-many with mixed sizes — verify minimum bound.
  // Input: 3 creditors, 4 debtors → ≤ max(3,4) = 4 transfers (lower bound 3).
  const balances: NetBalance[] = [
    { userId: 'u1', netMinor: 1000 },
    { userId: 'u2', netMinor: 500 },
    { userId: 'u3', netMinor: 200 },
    { userId: 'u4', netMinor: -700 },
    { userId: 'u5', netMinor: -500 },
    { userId: 'u6', netMinor: -300 },
    { userId: 'u7', netMinor: -200 },
  ];
  const t = BalanceEngine.simplify(balances);
  const sum = t.reduce((s, x) => s + x.amountMinor, 0);
  check('mixed: SUM(transfers) === SUM(creditor balances)', sum === 1700, t);
  check('mixed: ≤ 6 transfers (n−1 upper bound)', t.length <= 6, { count: t.length });
  // Every transfer amount should be positive.
  check('mixed: every transfer is positive', t.every((x) => x.amountMinor > 0));
}

// ──────────────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n✘ ${String(failures)} check(s) failed`);
  process.exit(1);
}
console.log('\n✔ all engine tests pass');
