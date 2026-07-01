/**
 * Unit tests for the BalanceEngine.
 *
 * Phase 3 model: ExpenseInput carries payments[] (multi-contributor) instead
 * of a single payerId. Tests cover:
 *
 * splitEqual
 *   - SUM(shares) === amount, payer absorbs remainder
 *   - rejects malformed input
 *
 * computeNetBalances — single-payer (Phase 2 parity)
 *   - SUM(net) === 0
 *   - rejects expenses whose stored shares drift from amount
 *
 * computeNetBalances — multi-payer (Phase 3)
 *   - two contributors splitting one expense
 *   - unequal split + unequal payment
 *   - contributor who is also a participant (self-pays)
 *   - zero net (no transfer needed)
 *   - former-member payer / participant
 *
 * computeNetBalances — payment dimension validation
 *   - empty payments array
 *   - negative contributionMinor
 *   - zero contributionMinor
 *   - contributions don't sum to amountMinor
 *   - duplicate contributor in one expense
 *
 * computeNetBalances + settlements
 *   - partial settlement, full settlement, over-payment
 *   - rejects malformed settlements
 *
 * simplify
 *   - empty / all-settled input
 *   - Goa-style 1 creditor × 3 debtors
 *   - determinism (input order doesn't matter)
 *   - tie-break by userId ASC
 *   - many-to-many transfer count bound
 */

import { BalanceEngine } from '../src/modules/expense/engine/balance-engine.js';
import type {
  ExpenseInput,
  NetBalance,
  SettlementTransfer,
} from '../src/modules/expense/engine/balance-engine.js';

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
  // Large amount: ₹100 crore split among 7
  const amount = 100_000_000_000;
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
// computeNetBalances — single-payer (Phase 2 parity)
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· computeNetBalances — single-payer (Phase 2 parity)');

{
  const memberIds = ['a', 'b', 'c'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 30_000,
      payments: [{ userId: 'a', contributionMinor: 30_000 }],
      participants: BalanceEngine.splitEqual(30_000, memberIds, 'a'),
    },
    {
      amountMinor: 9_000,
      payments: [{ userId: 'b', contributionMinor: 9_000 }],
      participants: BalanceEngine.splitEqual(9_000, memberIds, 'b'),
    },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  check('returns one row per member', net.length === 3);
  const sum = net.reduce((s, b) => s + b.netMinor, 0);
  check('SUM(net) === 0', sum === 0, net);
  // a: paid 30k; owes 10k + 3k = 13k → +17k
  // b: paid  9k; owes 10k + 3k = 13k → −4k
  // c: paid  0;  owes 10k + 3k = 13k → −13k
  check('a: paid 30k − owes 13k = +17k', net.find((b) => b.userId === 'a')?.netMinor === 17_000, net);
  check('b: paid  9k − owes 13k = −4k',  net.find((b) => b.userId === 'b')?.netMinor === -4_000, net);
  check('c: paid  0  − owes 13k = −13k', net.find((b) => b.userId === 'c')?.netMinor === -13_000, net);
}

{
  // Remainder fixture: SUM(net) must stay 0 even when floor-division leaves remainders.
  const memberIds = ['a', 'b', 'c'];
  const expenses: ExpenseInput[] = [
    { amountMinor: 100, payments: [{ userId: 'a', contributionMinor: 100 }], participants: BalanceEngine.splitEqual(100, memberIds, 'a') },
    { amountMinor: 100, payments: [{ userId: 'b', contributionMinor: 100 }], participants: BalanceEngine.splitEqual(100, memberIds, 'b') },
    { amountMinor: 100, payments: [{ userId: 'c', contributionMinor: 100 }], participants: BalanceEngine.splitEqual(100, memberIds, 'c') },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  const sum = net.reduce((s, b) => s + b.netMinor, 0);
  check('remainder: SUM(net) === 0 (no drift)', sum === 0, net);
}

{
  // Former-member: payer no longer a trip member but has residual activity.
  const memberIds = ['a', 'b'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 60,
      payments: [{ userId: 'x', contributionMinor: 60 }],
      participants: BalanceEngine.splitEqual(60, ['a', 'b', 'x'], 'x'),
    },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  check('former-member: row exists for x', net.find((b) => b.userId === 'x') !== undefined);
  check('former-member: SUM(net) === 0', net.reduce((s, b) => s + b.netMinor, 0) === 0, net);
  check(
    'former-member: current members come first',
    net[0]?.userId === 'a' && net[1]?.userId === 'b' && net[2]?.userId === 'x',
  );
}

console.log('\n· computeNetBalances rejects DB drift (share sum mismatch)');
expectThrow('shares do not sum to amount', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [
    {
      amountMinor: 100,
      payments: [{ userId: 'a', contributionMinor: 100 }],
      participants: [
        { userId: 'a', shareMinor: 50 },
        { userId: 'b', shareMinor: 49 }, // 99 ≠ 100
      ],
    },
  ]),
);

// ──────────────────────────────────────────────────────────────────────────────
// computeNetBalances — multi-payer (Phase 3 new scenarios)
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· computeNetBalances — multi-payer (Phase 3)');

{
  // Two equal contributors to one expense, equal 3-way split.
  // Expense: ₹300, a pays ₹150, b pays ₹150.
  // Participants: a, b, c each owe ₹100.
  // Expected net:
  //   a: +150 − 100 = +50
  //   b: +150 − 100 = +50
  //   c:   0  − 100 = −100
  const memberIds = ['a', 'b', 'c'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 300,
      payments: [
        { userId: 'a', contributionMinor: 150 },
        { userId: 'b', contributionMinor: 150 },
      ],
      participants: [
        { userId: 'a', shareMinor: 100 },
        { userId: 'b', shareMinor: 100 },
        { userId: 'c', shareMinor: 100 },
      ],
    },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  const sum = net.reduce((s, b) => s + b.netMinor, 0);
  check('two-payer: SUM(net) === 0', sum === 0, net);
  check('two-payer: a = +50',  net.find((b) => b.userId === 'a')?.netMinor === 50,  net);
  check('two-payer: b = +50',  net.find((b) => b.userId === 'b')?.netMinor === 50,  net);
  check('two-payer: c = −100', net.find((b) => b.userId === 'c')?.netMinor === -100, net);
  const transfers = BalanceEngine.simplify(net);
  check('two-payer: simplify → 1 transfer (c → both split)', transfers.length <= 2);
  check(
    'two-payer: SUM(transfers) === total credit',
    transfers.reduce((s, t) => s + t.amountMinor, 0) === 100,
  );
}

{
  // Unequal split + unequal payment.
  // Expense ₹1000: a pays ₹700, b pays ₹300.
  // Split: a owes ₹600, b owes ₹400.
  // Expected net:
  //   a: +700 − 600 = +100
  //   b: +300 − 400 = −100
  const memberIds = ['a', 'b'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 1_000,
      payments: [
        { userId: 'a', contributionMinor: 700 },
        { userId: 'b', contributionMinor: 300 },
      ],
      participants: [
        { userId: 'a', shareMinor: 600 },
        { userId: 'b', shareMinor: 400 },
      ],
    },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  check('unequal-split+payment: SUM(net) === 0', net.reduce((s, b) => s + b.netMinor, 0) === 0, net);
  check('unequal-split+payment: a = +100', net.find((b) => b.userId === 'a')?.netMinor === 100, net);
  check('unequal-split+payment: b = −100', net.find((b) => b.userId === 'b')?.netMinor === -100, net);
  const [t] = BalanceEngine.simplify(net);
  check(
    'unequal-split+payment: b → a 100',
    t?.fromUserId === 'b' && t?.toUserId === 'a' && t?.amountMinor === 100,
    t,
  );
}

{
  // Contributor who is also a participant (common case: group member pays and owes share).
  // Expense ₹900: a pays ₹600, b pays ₹300.
  // Split: a ₹300, b ₹300, c ₹300.
  // Expected net:
  //   a: +600 − 300 = +300
  //   b: +300 − 300 =   0
  //   c:   0  − 300 = −300
  const memberIds = ['a', 'b', 'c'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 900,
      payments: [
        { userId: 'a', contributionMinor: 600 },
        { userId: 'b', contributionMinor: 300 },
      ],
      participants: [
        { userId: 'a', shareMinor: 300 },
        { userId: 'b', shareMinor: 300 },
        { userId: 'c', shareMinor: 300 },
      ],
    },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  check('contributor-is-participant: SUM(net) === 0', net.reduce((s, b) => s + b.netMinor, 0) === 0, net);
  check('contributor-is-participant: a = +300', net.find((b) => b.userId === 'a')?.netMinor === 300, net);
  check('contributor-is-participant: b =   0',  net.find((b) => b.userId === 'b')?.netMinor === 0,   net);
  check('contributor-is-participant: c = −300', net.find((b) => b.userId === 'c')?.netMinor === -300, net);
  const transfers = BalanceEngine.simplify(net);
  check('contributor-is-participant: 1 transfer (c → a)', transfers.length === 1);
  check(
    'contributor-is-participant: c → a 300',
    transfers[0]?.fromUserId === 'c' && transfers[0]?.toUserId === 'a' && transfers[0]?.amountMinor === 300,
    transfers,
  );
}

{
  // Exact balances resulting in zero settlement.
  // Expense ₹200: a pays ₹200. Split: a ₹100, b ₹100.
  // Settlement: b → a ₹100 (completed).
  // After settlement: a = 0, b = 0 → no transfers needed.
  const memberIds = ['a', 'b'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 200,
      payments: [{ userId: 'a', contributionMinor: 200 }],
      participants: [
        { userId: 'a', shareMinor: 100 },
        { userId: 'b', shareMinor: 100 },
      ],
    },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses, [
    { fromUserId: 'b', toUserId: 'a', amountMinor: 100 },
  ]);
  check('zero-settlement: a = 0', net.find((b) => b.userId === 'a')?.netMinor === 0, net);
  check('zero-settlement: b = 0', net.find((b) => b.userId === 'b')?.netMinor === 0, net);
  check('zero-settlement: simplify → no transfers', BalanceEngine.simplify(net).length === 0);
}

{
  // Three payers, no participants who don't pay (everyone contributes and consumes).
  // Expense ₹300: a ₹100, b ₹100, c ₹100.
  // Each also owes ₹100. Net for everyone = 0.
  const memberIds = ['a', 'b', 'c'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 300,
      payments: [
        { userId: 'a', contributionMinor: 100 },
        { userId: 'b', contributionMinor: 100 },
        { userId: 'c', contributionMinor: 100 },
      ],
      participants: [
        { userId: 'a', shareMinor: 100 },
        { userId: 'b', shareMinor: 100 },
        { userId: 'c', shareMinor: 100 },
      ],
    },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  check('all-pay-all-owe: every net is 0', net.every((b) => b.netMinor === 0), net);
  check('all-pay-all-owe: simplify → no transfers', BalanceEngine.simplify(net).length === 0);
}

{
  // Former member was one of the contributors (multi-payer + removed user).
  // Expense ₹600: x (former) pays ₹400, a pays ₹200.
  // Split: a ₹200, b ₹200, x ₹200.
  // Expected net:
  //   a: +200 − 200 =   0
  //   b:   0  − 200 = −200
  //   x: +400 − 200 = +200  (sorted after current members)
  const memberIds = ['a', 'b'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 600,
      payments: [
        { userId: 'x', contributionMinor: 400 },
        { userId: 'a', contributionMinor: 200 },
      ],
      participants: [
        { userId: 'a', shareMinor: 200 },
        { userId: 'b', shareMinor: 200 },
        { userId: 'x', shareMinor: 200 },
      ],
    },
  ];
  const net = BalanceEngine.computeNetBalances(memberIds, expenses);
  check('former-payer: SUM(net) === 0', net.reduce((s, b) => s + b.netMinor, 0) === 0, net);
  check('former-payer: a = 0',   net.find((b) => b.userId === 'a')?.netMinor === 0,    net);
  check('former-payer: b = −200', net.find((b) => b.userId === 'b')?.netMinor === -200, net);
  check('former-payer: x = +200', net.find((b) => b.userId === 'x')?.netMinor === 200,  net);
  check(
    'former-payer: current members first, then x',
    net[0]?.userId === 'a' && net[1]?.userId === 'b' && net[2]?.userId === 'x',
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// computeNetBalances — payment dimension validation
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· computeNetBalances rejects invalid payment dimension');
expectThrow('empty payments array', () =>
  BalanceEngine.computeNetBalances(['a'], [
    {
      amountMinor: 100,
      payments: [],
      participants: [{ userId: 'a', shareMinor: 100 }],
    },
  ]),
);
expectThrow('negative contributionMinor', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [
    {
      amountMinor: 100,
      payments: [{ userId: 'a', contributionMinor: -1 }],
      participants: [{ userId: 'a', shareMinor: 50 }, { userId: 'b', shareMinor: 50 }],
    },
  ]),
);
expectThrow('zero contributionMinor', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [
    {
      amountMinor: 100,
      payments: [{ userId: 'a', contributionMinor: 0 }],
      participants: [{ userId: 'a', shareMinor: 50 }, { userId: 'b', shareMinor: 50 }],
    },
  ]),
);
expectThrow('contributions do not sum to amountMinor (under)', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [
    {
      amountMinor: 100,
      payments: [{ userId: 'a', contributionMinor: 99 }],
      participants: [{ userId: 'a', shareMinor: 50 }, { userId: 'b', shareMinor: 50 }],
    },
  ]),
);
expectThrow('contributions do not sum to amountMinor (over)', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [
    {
      amountMinor: 100,
      payments: [
        { userId: 'a', contributionMinor: 60 },
        { userId: 'b', contributionMinor: 50 }, // 110 ≠ 100
      ],
      participants: [{ userId: 'a', shareMinor: 50 }, { userId: 'b', shareMinor: 50 }],
    },
  ]),
);
expectThrow('duplicate contributor userId', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [
    {
      amountMinor: 100,
      payments: [
        { userId: 'a', contributionMinor: 50 },
        { userId: 'a', contributionMinor: 50 }, // duplicate
      ],
      participants: [{ userId: 'a', shareMinor: 50 }, { userId: 'b', shareMinor: 50 }],
    },
  ]),
);

// ──────────────────────────────────────────────────────────────────────────────
// computeNetBalances + settlements
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· computeNetBalances applies completed settlements');

{
  const memberIds = ['a', 'b', 'c'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 30_000,
      payments: [{ userId: 'a', contributionMinor: 30_000 }],
      participants: BalanceEngine.splitEqual(30_000, memberIds, 'a'),
    },
  ];

  const noSettlements = BalanceEngine.computeNetBalances(memberIds, expenses);
  check('baseline: a +20k', noSettlements.find((x) => x.userId === 'a')?.netMinor === 20_000);
  check('baseline: b −10k', noSettlements.find((x) => x.userId === 'b')?.netMinor === -10_000);
  check('baseline: c −10k', noSettlements.find((x) => x.userId === 'c')?.netMinor === -10_000);

  // b → a 10k
  const partialSettled = BalanceEngine.computeNetBalances(memberIds, expenses, [
    { fromUserId: 'b', toUserId: 'a', amountMinor: 10_000 },
  ]);
  check('partial: b zeroes out', partialSettled.find((x) => x.userId === 'b')?.netMinor === 0, partialSettled);
  check('partial: a drops to +10k', partialSettled.find((x) => x.userId === 'a')?.netMinor === 10_000);
  check('partial: c unchanged at −10k', partialSettled.find((x) => x.userId === 'c')?.netMinor === -10_000);
  check('partial: SUM(net) === 0', partialSettled.reduce((s, x) => s + x.netMinor, 0) === 0);

  // Both b → a 10k AND c → a 10k
  const allSettled = BalanceEngine.computeNetBalances(memberIds, expenses, [
    { fromUserId: 'b', toUserId: 'a', amountMinor: 10_000 },
    { fromUserId: 'c', toUserId: 'a', amountMinor: 10_000 },
  ]);
  check('fully settled: every net is 0', allSettled.every((x) => x.netMinor === 0), allSettled);
  check('fully settled: simplify → no transfers', BalanceEngine.simplify(allSettled).length === 0);

  // Over-payment: b → a 15k
  const overpaid = BalanceEngine.computeNetBalances(memberIds, expenses, [
    { fromUserId: 'b', toUserId: 'a', amountMinor: 15_000 },
  ]);
  check('over-payment: SUM(net) === 0', overpaid.reduce((s, x) => s + x.netMinor, 0) === 0, overpaid);
  check('over-payment: a drops to +5k', overpaid.find((x) => x.userId === 'a')?.netMinor === 5_000);
  check('over-payment: b flips to +5k', overpaid.find((x) => x.userId === 'b')?.netMinor === 5_000);
}

console.log('\n· computeNetBalances rejects malformed settlements');
expectThrow('settlement zero amount', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [], [
    { fromUserId: 'a', toUserId: 'b', amountMinor: 0 },
  ]),
);
expectThrow('settlement negative amount', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [], [
    { fromUserId: 'a', toUserId: 'b', amountMinor: -1 },
  ]),
);
expectThrow('settlement from === to', () =>
  BalanceEngine.computeNetBalances(['a', 'b'], [], [
    { fromUserId: 'a', toUserId: 'a', amountMinor: 100 },
  ]),
);

// ──────────────────────────────────────────────────────────────────────────────
// simplify
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· simplify');

{
  check('empty input → empty output', BalanceEngine.simplify([]).length === 0);
}

{
  const allSettled: NetBalance[] = [
    { userId: 'a', netMinor: 0 },
    { userId: 'b', netMinor: 0 },
  ];
  check('all-settled → empty', BalanceEngine.simplify(allSettled).length === 0);
}

{
  // Goa-style: 1 creditor (aarav 849k), 3 debtors
  const balances: NetBalance[] = [
    { userId: 'aarya', netMinor: -231_000 },
    { userId: 'aarav', netMinor: 849_000 },
    { userId: 'meera', netMinor: -171_000 },
    { userId: 'kabir', netMinor: -447_000 },
  ];
  const t = BalanceEngine.simplify(balances);
  check('Goa: 3 transfers', t.length === 3, t);
  check('Goa: SUM(transfers) === total debt', t.reduce((s, x) => s + x.amountMinor, 0) === 849_000);
  check('Goa: all transfers → aarav', t.every((x) => x.toUserId === 'aarav'));
  check('Goa: largest debtor (kabir) first', t[0]?.fromUserId === 'kabir' && t[0]?.amountMinor === 447_000);
  check('Goa: second is aarya 231k',  t[1]?.fromUserId === 'aarya' && t[1]?.amountMinor === 231_000);
  check('Goa: third is meera 171k',   t[2]?.fromUserId === 'meera' && t[2]?.amountMinor === 171_000);
}

{
  // Determinism: permuted input must produce same output
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
  check('determinism: input order does not change output', JSON.stringify(ta) === JSON.stringify(tb), { ta, tb });
  check('tie-break: u2 settles first (lex < u3)', ta[0]?.fromUserId === 'u2' && ta[1]?.fromUserId === 'u3', ta);
}

{
  // Single creditor–debtor pair
  const t = BalanceEngine.simplify([
    { userId: 'a', netMinor: 1234 },
    { userId: 'b', netMinor: -1234 },
  ]);
  check('single pair: 1 transfer', t.length === 1);
  check(
    'single pair: b → a 1234',
    t[0]?.fromUserId === 'b' && t[0]?.toUserId === 'a' && t[0]?.amountMinor === 1234,
  );
}

{
  // Many-to-many: 3 creditors, 4 debtors → ≤ 6 transfers
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
  check('mixed: SUM(transfers) === SUM(credits)', t.reduce((s, x) => s + x.amountMinor, 0) === 1700, t);
  check('mixed: ≤ 6 transfers', t.length <= 6, { count: t.length });
  check('mixed: every transfer is positive', t.every((x) => x.amountMinor > 0));
}

// ──────────────────────────────────────────────────────────────────────────────
// Deletion semantics (Phase 4E)
//
// The balance engine is unaware of soft-delete; it only sees the expenses
// passed to it. These tests verify that omitting a deleted expense from the
// engine input produces the correct recomputed balances, which is exactly
// what happens when the service excludes soft-deleted rows via `notDeleted`.
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· deletion semantics (Phase 4E)');

{
  // Delete a single-payer expense.
  // Before delete: a paid ₹300, split 3 ways → a=+200, b=−100, c=−100
  // After delete: no expenses → all nets = 0
  const memberIds = ['a', 'b', 'c'];
  const expense: ExpenseInput = {
    amountMinor: 300,
    payments: [{ userId: 'a', contributionMinor: 300 }],
    participants: [
      { userId: 'a', shareMinor: 100 },
      { userId: 'b', shareMinor: 100 },
      { userId: 'c', shareMinor: 100 },
    ],
  };

  const before = BalanceEngine.computeNetBalances(memberIds, [expense]);
  check('delete single-payer: before — a = +200', before.find((x) => x.userId === 'a')?.netMinor === 200, before);
  check('delete single-payer: before — b = −100', before.find((x) => x.userId === 'b')?.netMinor === -100);
  check('delete single-payer: before — c = −100', before.find((x) => x.userId === 'c')?.netMinor === -100);

  const after = BalanceEngine.computeNetBalances(memberIds, []); // expense omitted (soft-deleted)
  check('delete single-payer: after — all nets = 0', after.every((x) => x.netMinor === 0), after);
  check('delete single-payer: after — simplify → no transfers', BalanceEngine.simplify(after).length === 0);
}

{
  // Delete a multi-payer expense.
  // Expense ₹600: a pays ₹400, b pays ₹200. Split: a ₹200, b ₹200, c ₹200.
  // Before: a=+200, b=0, c=−200
  // After (deleted): all 0
  const memberIds = ['a', 'b', 'c'];
  const multiPayerExpense: ExpenseInput = {
    amountMinor: 600,
    payments: [
      { userId: 'a', contributionMinor: 400 },
      { userId: 'b', contributionMinor: 200 },
    ],
    participants: [
      { userId: 'a', shareMinor: 200 },
      { userId: 'b', shareMinor: 200 },
      { userId: 'c', shareMinor: 200 },
    ],
  };

  const before = BalanceEngine.computeNetBalances(memberIds, [multiPayerExpense]);
  check('delete multi-payer: before — a = +200', before.find((x) => x.userId === 'a')?.netMinor === 200, before);
  check('delete multi-payer: before — b = 0',   before.find((x) => x.userId === 'b')?.netMinor === 0);
  check('delete multi-payer: before — c = −200', before.find((x) => x.userId === 'c')?.netMinor === -200);
  check('delete multi-payer: before — SUM = 0', before.reduce((s, x) => s + x.netMinor, 0) === 0);

  const after = BalanceEngine.computeNetBalances(memberIds, []);
  check('delete multi-payer: after — all nets = 0', after.every((x) => x.netMinor === 0), after);
}

{
  // Delete an expense that has an uneven split (non-divisible amount).
  // Expense ₹100, 3 participants, equal split → payer(a)=34, b=33, c=33.
  // Deleting it removes all obligations.
  const memberIds = ['a', 'b', 'c'];
  const unevenExpense: ExpenseInput = {
    amountMinor: 100,
    payments: [{ userId: 'a', contributionMinor: 100 }],
    participants: BalanceEngine.splitEqual(100, memberIds, 'a'),
  };

  const before = BalanceEngine.computeNetBalances(memberIds, [unevenExpense]);
  check('delete uneven: before — SUM = 0', before.reduce((s, x) => s + x.netMinor, 0) === 0);
  check('delete uneven: before — a positive', (before.find((x) => x.userId === 'a')?.netMinor ?? 0) > 0);

  const after = BalanceEngine.computeNetBalances(memberIds, []);
  check('delete uneven: after — SUM = 0', after.reduce((s, x) => s + x.netMinor, 0) === 0, after);
  check('delete uneven: after — all zero', after.every((x) => x.netMinor === 0));
}

{
  // Delete an expense after a settlement was recorded for it.
  // Before settlement: a paid ₹200, a=+100, b=−100.
  // After settlement (b→a 100): both 0.
  // Now soft-delete the expense. The settlement is a historical fact — it persists.
  // Engine sees: no expenses + one completed settlement (b paid a ₹100).
  // Net: a = 0 − 100 = −100 (settlement receiver loses credit),
  //       b = 0 + 100 = +100 (settlement sender gains credit).
  // This correctly reflects the real-world state: b paid a ₹100 in cash, the
  // underlying expense is gone, so now a owes b ₹100.
  const memberIds = ['a', 'b'];

  const expenseWithSettlement: ExpenseInput = {
    amountMinor: 200,
    payments: [{ userId: 'a', contributionMinor: 200 }],
    participants: [{ userId: 'a', shareMinor: 100 }, { userId: 'b', shareMinor: 100 }],
  };
  const settlement = { fromUserId: 'b', toUserId: 'a', amountMinor: 100 };

  const settled = BalanceEngine.computeNetBalances(memberIds, [expenseWithSettlement], [settlement]);
  check('delete-after-settlement: settled state — both 0', settled.every((x) => x.netMinor === 0), settled);

  // Now expense is deleted (omitted from engine input). Settlement persists.
  const afterDelete = BalanceEngine.computeNetBalances(memberIds, [], [settlement]);
  check('delete-after-settlement: after delete — SUM = 0', afterDelete.reduce((s, x) => s + x.netMinor, 0) === 0);
  check('delete-after-settlement: a = −100 (owes settlement back)', afterDelete.find((x) => x.userId === 'a')?.netMinor === -100, afterDelete);
  check('delete-after-settlement: b = +100 (overpaid, now creditor)', afterDelete.find((x) => x.userId === 'b')?.netMinor === 100);
  const transfers = BalanceEngine.simplify(afterDelete);
  check('delete-after-settlement: 1 reverse transfer (a → b)', transfers.length === 1 && transfers[0]?.fromUserId === 'a' && transfers[0]?.toUserId === 'b');
}

{
  // Two expenses; delete only the first. Remaining expense balances are correct.
  // Expense 1 (to be deleted): a paid ₹300, split a/b/c equally.
  // Expense 2 (kept): b paid ₹150, split a/b equally.
  // After deleting expense 1:
  //   b: +150 − 75 = +75
  //   a:   0  − 75 = −75
  //   c:   0  −  0 =   0
  const memberIds = ['a', 'b', 'c'];
  const exp1: ExpenseInput = {
    amountMinor: 300,
    payments: [{ userId: 'a', contributionMinor: 300 }],
    participants: BalanceEngine.splitEqual(300, memberIds, 'a'),
  };
  const exp2: ExpenseInput = {
    amountMinor: 150,
    payments: [{ userId: 'b', contributionMinor: 150 }],
    participants: BalanceEngine.splitEqual(150, ['a', 'b'], 'b'),
  };

  const both = BalanceEngine.computeNetBalances(memberIds, [exp1, exp2]);
  check('delete partial: both expenses SUM = 0', both.reduce((s, x) => s + x.netMinor, 0) === 0);

  const afterDelete1 = BalanceEngine.computeNetBalances(memberIds, [exp2]);
  check('delete partial: after — SUM = 0', afterDelete1.reduce((s, x) => s + x.netMinor, 0) === 0, afterDelete1);
  check('delete partial: after — b = +75',  afterDelete1.find((x) => x.userId === 'b')?.netMinor === 75);
  check('delete partial: after — a = −75',  afterDelete1.find((x) => x.userId === 'a')?.netMinor === -75);
  check('delete partial: after — c = 0',    afterDelete1.find((x) => x.userId === 'c')?.netMinor === 0);
}

// ──────────────────────────────────────────────────────────────────────────────
// computePairwiseDebts — per-pair "who owes whom" (default / free-tier view)
//
// Contrast with simplify: pairwise PRESERVES the real counterparties instead of
// routing every debt to the largest creditor. These tests also assert the
// parity invariant that ties pairwise back to computeNetBalances so the two
// code paths can never drift.
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· computePairwiseDebts');

/** Amount `from` owes `to` in a pairwise transfer list, or 0 if absent. */
function pair(transfers: SettlementTransfer[], from: string, to: string): number {
  return transfers.find((t) => t.fromUserId === from && t.toUserId === to)?.amountMinor ?? 0;
}

/**
 * Parity check: for every user, (total they owe − total owed to them) in the
 * pairwise view must equal the NEGATION of their aggregate net. This is the
 * closed-form link between computePairwiseDebts and computeNetBalances.
 */
function pairwiseReconcilesToNet(
  memberIds: string[],
  expenses: ExpenseInput[],
  settlements: SettlementTransfer[] = [],
): boolean {
  const net = BalanceEngine.computeNetBalances(memberIds, expenses, settlements);
  const pw = BalanceEngine.computePairwiseDebts(memberIds, expenses, settlements);
  return net.every((b) => {
    const owes = pw.filter((t) => t.fromUserId === b.userId).reduce((s, t) => s + t.amountMinor, 0);
    const owed = pw.filter((t) => t.toUserId === b.userId).reduce((s, t) => s + t.amountMinor, 0);
    return owes - owed === -b.netMinor;
  });
}

{
  // The "middle person gets bypassed" crux — a miniature of the reported
  // "Long weekend" bug. b sits between a and c:
  //   Expense 1: b pays ₹200, split a/b → a owes b ₹100.
  //   Expense 2: c pays ₹200, split b/c → b owes c ₹100.
  // Pairwise keeps BOTH real debts (a→b, b→c). simplify collapses the chain to
  // a single a→c ₹100 and drops b entirely — which is exactly why Harpal's
  // "owes Kanwarpreet" debt disappeared on the settle-up screen.
  const memberIds = ['a', 'b', 'c'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 200,
      payments: [{ userId: 'b', contributionMinor: 200 }],
      participants: [{ userId: 'a', shareMinor: 100 }, { userId: 'b', shareMinor: 100 }],
    },
    {
      amountMinor: 200,
      payments: [{ userId: 'c', contributionMinor: 200 }],
      participants: [{ userId: 'b', shareMinor: 100 }, { userId: 'c', shareMinor: 100 }],
    },
  ];
  const pw = BalanceEngine.computePairwiseDebts(memberIds, expenses);
  check('bypass: pairwise keeps a → b 100', pair(pw, 'a', 'b') === 100, pw);
  check('bypass: pairwise keeps b → c 100', pair(pw, 'b', 'c') === 100, pw);
  check('bypass: pairwise has exactly 2 transfers', pw.length === 2, pw);

  const simplified = BalanceEngine.simplify(BalanceEngine.computeNetBalances(memberIds, expenses));
  check('bypass: simplify collapses to a → c 100', simplified.length === 1 && pair(simplified, 'a', 'c') === 100, simplified);
  check('bypass: simplify drops b entirely', simplified.every((t) => t.fromUserId !== 'b' && t.toUserId !== 'b'), simplified);
  check('bypass: pairwise reconciles to net', pairwiseReconcilesToNet(memberIds, expenses));
}

{
  // Full "Long weekend" fixture (4 people, single-payer expenses):
  //   honey pays ₹1200 split 4 ways (₹300 each).
  //   kanwar pays ₹500 split 4 ways (₹125 each) → harpal owes kanwar ₹125.
  // Pairwise must SHOW the harpal→kanwar ₹125 and harpal→honey ₹300 debts,
  // whereas simplify nets kanwar's small credit away.
  const memberIds = ['honey', 'kanwar', 'harpal', 'dev'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 1200,
      payments: [{ userId: 'honey', contributionMinor: 1200 }],
      participants: [
        { userId: 'honey', shareMinor: 300 },
        { userId: 'kanwar', shareMinor: 300 },
        { userId: 'harpal', shareMinor: 300 },
        { userId: 'dev', shareMinor: 300 },
      ],
    },
    {
      amountMinor: 500,
      payments: [{ userId: 'kanwar', contributionMinor: 500 }],
      participants: [
        { userId: 'honey', shareMinor: 125 },
        { userId: 'kanwar', shareMinor: 125 },
        { userId: 'harpal', shareMinor: 125 },
        { userId: 'dev', shareMinor: 125 },
      ],
    },
  ];
  const pw = BalanceEngine.computePairwiseDebts(memberIds, expenses);
  check('long-weekend: pairwise harpal → kanwar 125 (preserved)', pair(pw, 'harpal', 'kanwar') === 125, pw);
  check('long-weekend: pairwise harpal → honey 300 (preserved)', pair(pw, 'harpal', 'honey') === 300, pw);
  check('long-weekend: pairwise kanwar → honey 175 (300 − 125 netted)', pair(pw, 'kanwar', 'honey') === 175, pw);
  check('long-weekend: pairwise reconciles to net', pairwiseReconcilesToNet(memberIds, expenses));

  const simplified = BalanceEngine.simplify(BalanceEngine.computeNetBalances(memberIds, expenses));
  // simplify collects kanwar's +75 credit, so harpal's direct debt to kanwar is
  // reduced below the real ₹125 — the crux of the user's complaint.
  check('long-weekend: simplify reduces harpal → kanwar below 125', pair(simplified, 'harpal', 'kanwar') < 125, simplified);
}

{
  // Settlements shrink the pairwise debt for that exact pair.
  //   a owes b ₹100; a pays b ₹60 → pairwise a → b ₹40.
  const memberIds = ['a', 'b'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 200,
      payments: [{ userId: 'b', contributionMinor: 200 }],
      participants: [{ userId: 'a', shareMinor: 100 }, { userId: 'b', shareMinor: 100 }],
    },
  ];
  const settlements: SettlementTransfer[] = [{ fromUserId: 'a', toUserId: 'b', amountMinor: 60 }];
  const pw = BalanceEngine.computePairwiseDebts(memberIds, expenses, settlements);
  check('settlement: pairwise a → b reduced to 40', pair(pw, 'a', 'b') === 40, pw);
  check('settlement: pairwise reconciles to net', pairwiseReconcilesToNet(memberIds, expenses, settlements));

  // Over-payment flips the pair direction.
  const over: SettlementTransfer[] = [{ fromUserId: 'a', toUserId: 'b', amountMinor: 130 }];
  const pwOver = BalanceEngine.computePairwiseDebts(memberIds, expenses, over);
  check('over-settlement: pairwise flips to b → a 30', pair(pwOver, 'b', 'a') === 30, pwOver);
  check('over-settlement: pairwise reconciles to net', pairwiseReconcilesToNet(memberIds, expenses, over));
}

{
  // Multi-payer decomposition preserves BOTH margins exactly.
  //   Expense ₹100: payers a=₹60, b=₹40. Participants x=₹50, y=₹50.
  // Each participant owes exactly their share; each payer is owed exactly
  // their contribution. Integer-only, no drift.
  const memberIds = ['a', 'b', 'x', 'y'];
  const expenses: ExpenseInput[] = [
    {
      amountMinor: 100,
      payments: [
        { userId: 'a', contributionMinor: 60 },
        { userId: 'b', contributionMinor: 40 },
      ],
      participants: [
        { userId: 'x', shareMinor: 50 },
        { userId: 'y', shareMinor: 50 },
      ],
    },
  ];
  const pw = BalanceEngine.computePairwiseDebts(memberIds, expenses);
  // x owes 50 total, y owes 50 total; a owed 60, b owed 40.
  const xOwes = pw.filter((t) => t.fromUserId === 'x').reduce((s, t) => s + t.amountMinor, 0);
  const yOwes = pw.filter((t) => t.fromUserId === 'y').reduce((s, t) => s + t.amountMinor, 0);
  const aOwed = pw.filter((t) => t.toUserId === 'a').reduce((s, t) => s + t.amountMinor, 0);
  const bOwed = pw.filter((t) => t.toUserId === 'b').reduce((s, t) => s + t.amountMinor, 0);
  check('multi-payer: x owes exactly 50 (row margin)', xOwes === 50, pw);
  check('multi-payer: y owes exactly 50 (row margin)', yOwes === 50, pw);
  check('multi-payer: a owed exactly 60 (col margin)', aOwed === 60, pw);
  check('multi-payer: b owed exactly 40 (col margin)', bOwed === 40, pw);
  check('multi-payer: pairwise reconciles to net', pairwiseReconcilesToNet(memberIds, expenses));
}

{
  // Determinism: permuted expense/participant order yields identical pairwise output.
  const memberIds = ['a', 'b', 'c'];
  const e1: ExpenseInput = {
    amountMinor: 300,
    payments: [{ userId: 'a', contributionMinor: 300 }],
    participants: [
      { userId: 'a', shareMinor: 100 },
      { userId: 'b', shareMinor: 100 },
      { userId: 'c', shareMinor: 100 },
    ],
  };
  const e1Permuted: ExpenseInput = {
    amountMinor: 300,
    payments: [{ userId: 'a', contributionMinor: 300 }],
    participants: [
      { userId: 'c', shareMinor: 100 },
      { userId: 'a', shareMinor: 100 },
      { userId: 'b', shareMinor: 100 },
    ],
  };
  const p1 = BalanceEngine.computePairwiseDebts(memberIds, [e1]);
  const p2 = BalanceEngine.computePairwiseDebts(memberIds, [e1Permuted]);
  check('determinism: participant order does not change output', JSON.stringify(p1) === JSON.stringify(p2), { p1, p2 });
}

// ──────────────────────────────────────────────────────────────────────────────
// Randomized balance invariant (Phase 4H)
//
// For any combination of expenses (any split, any number of payers) and
// completed settlements, SUM(netMinor) must always equal 0.
//
// Each trial generates:
//   - 3–6 members
//   - 5–15 expenses with random amounts, payers, and participants
//   - 0–5 settlements with random amounts and directions
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n· randomized balance invariant (Phase 4H)');

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomSubset<T>(arr: T[], minSize: number, maxSize: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, randomInt(minSize, Math.min(maxSize, arr.length)));
}

function buildRandomExpense(memberIds: string[]): ExpenseInput {
  const amountMinor = randomInt(1, 1_000_000);

  // Random subset of payers (1–min(3, n))
  const payers = randomSubset(memberIds, 1, Math.min(3, memberIds.length));
  // Distribute amountMinor across payers (first payer absorbs remainder)
  const baseContrib = Math.floor(amountMinor / payers.length);
  let remaining = amountMinor;
  const payments = payers.map((userId, idx) => {
    const contributionMinor = idx === payers.length - 1 ? remaining : baseContrib;
    remaining -= baseContrib;
    return { userId, contributionMinor };
  });

  // Random subset of participants (1–n)
  const participants = randomSubset(memberIds, 1, memberIds.length);
  // Equal-split among participants (primary payer absorbs remainder)
  const primaryPayer = payers[0]!;
  const primaryPayerIsParticipant = participants.includes(primaryPayer);
  const pivotId = primaryPayerIsParticipant ? primaryPayer : participants[0]!;
  const shares = BalanceEngine.splitEqual(amountMinor, participants, pivotId);

  return { amountMinor, payments, participants: shares };
}

const TRIAL_COUNT = 200;
let invariantViolations = 0;
let pairwiseParityViolations = 0;

for (let trial = 0; trial < TRIAL_COUNT; trial++) {
  const memberCount = randomInt(3, 6);
  const memberIds = Array.from({ length: memberCount }, (_, i) => `u${String(i)}`);

  const expenseCount = randomInt(5, 15);
  const expenses = Array.from({ length: expenseCount }, () => buildRandomExpense(memberIds));

  // Random settlements between distinct members
  const settlementCount = randomInt(0, 5);
  const settlements = Array.from({ length: settlementCount }, () => {
    const [from, to] = randomSubset(memberIds, 2, 2) as [string, string];
    return { fromUserId: from, toUserId: to, amountMinor: randomInt(1, 500_000) };
  });

  const net = BalanceEngine.computeNetBalances(memberIds, expenses, settlements);
  const sum = net.reduce((s, x) => s + x.netMinor, 0);
  if (sum !== 0) {
    invariantViolations += 1;
    failures += 1;
    console.error(`  ✘ trial ${String(trial)}: SUM(net) = ${String(sum)} ≠ 0`, { net });
  }

  // Pairwise view must reconcile to the aggregate net (per-user), including
  // multi-payer decomposition and settlements. This is the guarantee that the
  // free-tier pairwise screen and the premium simplify screen agree on totals.
  const pw = BalanceEngine.computePairwiseDebts(memberIds, expenses, settlements);
  const parityOk = net.every((b) => {
    const owes = pw.filter((t) => t.fromUserId === b.userId).reduce((s, t) => s + t.amountMinor, 0);
    const owed = pw.filter((t) => t.toUserId === b.userId).reduce((s, t) => s + t.amountMinor, 0);
    return owes - owed === -b.netMinor;
  });
  if (!parityOk) {
    pairwiseParityViolations += 1;
    failures += 1;
    console.error(`  ✘ trial ${String(trial)}: pairwise does not reconcile to net`, { net, pw });
  }
}

check(
  `randomized: ${String(TRIAL_COUNT)} trials — SUM(net) === 0 in every trial`,
  invariantViolations === 0,
  invariantViolations > 0 ? { violations: invariantViolations } : undefined,
);
check(
  `randomized: ${String(TRIAL_COUNT)} trials — pairwise reconciles to net in every trial`,
  pairwiseParityViolations === 0,
  pairwiseParityViolations > 0 ? { violations: pairwiseParityViolations } : undefined,
);

// ──────────────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n✘ ${String(failures)} check(s) failed`);
  process.exit(1);
}
console.log('\n✔ all engine tests pass');
