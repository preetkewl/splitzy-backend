/**
 * Isolated unit tests for the four SplitCalculator implementations and the
 * SplitCalculatorRegistry dispatcher.
 *
 * Each calculator is instantiated directly (not via the production registry)
 * so tests are fully decoupled from the DI wiring.
 *
 * Coverage checklist:
 *   EQUAL    — clean division, payer-absorbs-remainder, single participant,
 *              large amount, malformed input (throws)
 *   EXACT    — clean sum, payer at zero, invalid (negative / non-integer /
 *              missing field / sum mismatch) all throw
 *   PERCENT  — clean 100bp division, LRM remainder distributed to largest-frac
 *              participant, tie-break by userId ASC, sum-invariant holds,
 *              invalid (missing field / out-of-range / wrong sum) all throw
 *   SHARES   — clean proportional, LRM remainder, BigInt overflow safety,
 *              invalid (missing field / zero / out-of-range) all throw
 *   REGISTRY — all four types dispatch correctly, unknown type throws,
 *              duplicate registration throws
 *   MIXED    — mixed split types on one "trip" produce correct aggregate
 *              SUM(shareMinor) across all expenses
 *
 * Run: npx tsx scripts/split-calculator-test.ts
 */

import {
  EqualSplitCalculator,
  ExactSplitCalculator,
  PercentSplitCalculator,
  SharesSplitCalculator,
  SplitCalculatorRegistry,
  splitRegistry,
} from '../src/modules/expense/engine/index.js';
import type { SplitResult } from '../src/modules/expense/engine/index.js';

// ── Test harness ──────────────────────────────────────────────────────────────

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✘ ${name}`);
    if (detail !== undefined) console.error('    ', JSON.stringify(detail, null, 2));
  }
}

function expectThrow(name: string, fn: () => unknown): void {
  try {
    fn();
    failures += 1;
    console.error(`  ✘ ${name} (expected throw, got success)`);
  } catch (err) {
    console.log(`  ✓ ${name} — threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Assert every shareMinor is a positive (or zero) integer and SUM === amount. */
function checkInvariant(name: string, results: SplitResult[], amountMinor: number): void {
  const allIntegers = results.every((r) => Number.isInteger(r.shareMinor) && r.shareMinor >= 0);
  check(`${name}: all shareMinor are non-negative integers`, allIntegers, results);

  const sum = results.reduce((acc, r) => acc + r.shareMinor, 0);
  check(`${name}: SUM(shareMinor) === amountMinor`, sum === amountMinor, {
    sum,
    amountMinor,
    diff: sum - amountMinor,
  });
}

// ── EQUAL calculator ──────────────────────────────────────────────────────────

console.log('\n· EqualSplitCalculator');

const equal = new EqualSplitCalculator();

{
  // Clean division: ₹1 200 / 4 = ₹300 each
  const r = equal.calculate(120_000, [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }, { userId: 'd' }], 'a');
  check('clean division: 4×30000', r.every((x) => x.shareMinor === 30_000), r);
  checkInvariant('clean division', r, 120_000);
  check('metadata all null', r.every((x) => x.basisPoints === null && x.shareUnits === null && x.exactAmountMinor === null));
}

{
  // Remainder: 100 minor units / 3 = 33.33… payer absorbs +1
  const r = equal.calculate(100, [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }], 'b');
  check('remainder: payer gets 34', r.find((x) => x.userId === 'b')?.shareMinor === 34, r);
  check('remainder: non-payers get 33', r.filter((x) => x.userId !== 'b').every((x) => x.shareMinor === 33));
  checkInvariant('remainder', r, 100);
}

{
  // Single participant (payer pays for themselves)
  const r = equal.calculate(99_999, [{ userId: 'solo' }], 'solo');
  check('single participant: gets entire amount', r[0]?.shareMinor === 99_999);
  checkInvariant('single', r, 99_999);
}

{
  // Large amount near MAX_EXPENSE_AMOUNT_MINOR with 7 participants
  const amount = 100_000_000_007; // odd to guarantee a remainder
  const ids = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'].map((userId) => ({ userId }));
  const r = equal.calculate(amount, ids, 'u4');
  checkInvariant('large amount (7 participants)', r, amount);
}

console.log('\n· EqualSplitCalculator — invalid input');
expectThrow('zero amount', () => equal.calculate(0, [{ userId: 'a' }], 'a'));
expectThrow('negative amount', () => equal.calculate(-1, [{ userId: 'a' }], 'a'));
expectThrow('empty participants', () => equal.calculate(100, [], 'a'));
expectThrow('payer not in participants', () => equal.calculate(100, [{ userId: 'a' }], 'b'));

// ── EXACT calculator ──────────────────────────────────────────────────────────

console.log('\n· ExactSplitCalculator');

const exact = new ExactSplitCalculator();

{
  // Standard: 3 participants with exact amounts
  const r = exact.calculate(
    100_000,
    [
      { userId: 'a', exactAmountMinor: 60_000 },
      { userId: 'b', exactAmountMinor: 30_000 },
      { userId: 'c', exactAmountMinor: 10_000 },
    ],
    'a',
  );
  check('exact: a gets 60000', r.find((x) => x.userId === 'a')?.shareMinor === 60_000);
  check('exact: b gets 30000', r.find((x) => x.userId === 'b')?.shareMinor === 30_000);
  check('exact: c gets 10000', r.find((x) => x.userId === 'c')?.shareMinor === 10_000);
  check('exact: exactAmountMinor metadata set', r.every((x) => x.exactAmountMinor !== null));
  check('exact: basisPoints null', r.every((x) => x.basisPoints === null));
  check('exact: shareUnits null', r.every((x) => x.shareUnits === null));
  checkInvariant('exact standard', r, 100_000);
}

{
  // Payer covers everyone — their own share is 0
  const r = exact.calculate(
    50_000,
    [
      { userId: 'payer', exactAmountMinor: 0 },
      { userId: 'guest', exactAmountMinor: 50_000 },
    ],
    'payer',
  );
  check('exact: payer at 0', r.find((x) => x.userId === 'payer')?.shareMinor === 0);
  check('exact: payer exactAmountMinor=0 stored', r.find((x) => x.userId === 'payer')?.exactAmountMinor === 0);
  checkInvariant('exact payer-zero', r, 50_000);
}

{
  // Single participant pays for themselves
  const r = exact.calculate(77_777, [{ userId: 'alone', exactAmountMinor: 77_777 }], 'alone');
  checkInvariant('exact single', r, 77_777);
}

console.log('\n· ExactSplitCalculator — invalid input');
expectThrow('sum mismatch (too low)', () =>
  exact.calculate(100, [{ userId: 'a', exactAmountMinor: 60 }, { userId: 'b', exactAmountMinor: 39 }], 'a'),
);
expectThrow('sum mismatch (too high)', () =>
  exact.calculate(100, [{ userId: 'a', exactAmountMinor: 60 }, { userId: 'b', exactAmountMinor: 41 }], 'a'),
);
expectThrow('negative exactAmountMinor', () =>
  exact.calculate(100, [{ userId: 'a', exactAmountMinor: -1 }, { userId: 'b', exactAmountMinor: 101 }], 'a'),
);
expectThrow('non-integer exactAmountMinor', () =>
  exact.calculate(100, [{ userId: 'a', exactAmountMinor: 50.5 }, { userId: 'b', exactAmountMinor: 49.5 }], 'a'),
);
expectThrow('missing exactAmountMinor field', () =>
  exact.calculate(100, [{ userId: 'a' }, { userId: 'b', exactAmountMinor: 100 }], 'a'),
);
expectThrow('empty participants', () => exact.calculate(100, [], 'a'));

// ── PERCENT calculator ────────────────────────────────────────────────────────

console.log('\n· PercentSplitCalculator');

const percent = new PercentSplitCalculator();

{
  // Clean: 25%/25%/50% of 120 000 minor units = 30 000/30 000/60 000 (no remainder)
  const r = percent.calculate(
    120_000,
    [
      { userId: 'a', basisPoints: 2_500 },
      { userId: 'b', basisPoints: 2_500 },
      { userId: 'c', basisPoints: 5_000 },
    ],
    'a',
  );
  check('25/25/50: a=30000', r.find((x) => x.userId === 'a')?.shareMinor === 30_000, r);
  check('25/25/50: b=30000', r.find((x) => x.userId === 'b')?.shareMinor === 30_000);
  check('25/25/50: c=60000', r.find((x) => x.userId === 'c')?.shareMinor === 60_000);
  check('basisPoints metadata set', r.every((x) => x.basisPoints !== null && x.shareUnits === null && x.exactAmountMinor === null));
  checkInvariant('percent 25/25/50', r, 120_000);
}

{
  // LRM remainder: 3333/3333/3334 bp of 100 minor units
  // Ideal: 33.33/33.33/33.34 → floors: 33/33/33, remainder=1
  // Remainders: 3333%10000=3333 for a, 3333 for b, 3334%10000=3334 for c → c gets extra
  const r = percent.calculate(
    100,
    [
      { userId: 'a', basisPoints: 3_333 },
      { userId: 'b', basisPoints: 3_333 },
      { userId: 'c', basisPoints: 3_334 },
    ],
    'a',
  );
  // a: floor(3333×100/10000) = floor(33.33) = 33, rem_num = 3333*100 mod 10000 = 3300
  // b: same as a = 33, rem_num = 3300
  // c: floor(3334×100/10000) = floor(33.34) = 33, rem_num = 3334*100 mod 10000 = 3400
  // totalFloor = 99, extraMinor = 1
  // sorted by rem_num DESC: c(3400) > a(3300) = b(3300)
  // tie-break a vs b by userId ASC: a < b → a would get it before b
  // But extraMinor=1: only c gets the extra (c has highest rem)
  check('3333/3333/3334: c gets extra', r.find((x) => x.userId === 'c')?.shareMinor === 34, r);
  check('3333/3333/3334: a gets 33', r.find((x) => x.userId === 'a')?.shareMinor === 33, r);
  check('3333/3333/3334: b gets 33', r.find((x) => x.userId === 'b')?.shareMinor === 33, r);
  checkInvariant('percent LRM 3-way', r, 100);
}

{
  // LRM tie-break: equal fractional remainders resolved by userId ASC
  // 5000/5000 bp of 1 minor units: each ideal=0.5, floors=0/0, remainder=1
  // rem_num: both 5000×1 mod 10000 = 5000 → tie → userId ASC ('a' < 'b') → 'a' gets extra
  const r = percent.calculate(
    1,
    [{ userId: 'b', basisPoints: 5_000 }, { userId: 'a', basisPoints: 5_000 }],
    'a',
  );
  check('tie-break: userId ASC gets extra (a < b)', r.find((x) => x.userId === 'a')?.shareMinor === 1, r);
  check('tie-break: b gets 0', r.find((x) => x.userId === 'b')?.shareMinor === 0, r);
  checkInvariant('percent tie-break', r, 1);
}

{
  // Single participant at 100%
  const r = percent.calculate(999_999, [{ userId: 'all', basisPoints: 10_000 }], 'all');
  check('100%: single participant gets everything', r[0]?.shareMinor === 999_999);
  checkInvariant('percent single 100%', r, 999_999);
}

{
  // Large amount near MAX, 3 unequal percentages
  const amount = 99_999_999_999;
  const r = percent.calculate(
    amount,
    [
      { userId: 'p1', basisPoints: 1_234 },
      { userId: 'p2', basisPoints: 5_678 },
      { userId: 'p3', basisPoints: 3_088 },
    ],
    'p1',
  );
  checkInvariant('percent large amount', r, amount);
}

console.log('\n· PercentSplitCalculator — invalid input');
expectThrow('sum !== 10000 (9999)', () =>
  percent.calculate(100, [{ userId: 'a', basisPoints: 5_000 }, { userId: 'b', basisPoints: 4_999 }], 'a'),
);
expectThrow('sum !== 10000 (10001)', () =>
  percent.calculate(100, [{ userId: 'a', basisPoints: 5_001 }, { userId: 'b', basisPoints: 5_000 }], 'a'),
);
expectThrow('basisPoints = 0', () =>
  percent.calculate(100, [{ userId: 'a', basisPoints: 0 }, { userId: 'b', basisPoints: 10_000 }], 'a'),
);
expectThrow('basisPoints > 10000', () =>
  percent.calculate(100, [{ userId: 'a', basisPoints: 10_001 }], 'a'),
);
expectThrow('missing basisPoints', () =>
  percent.calculate(100, [{ userId: 'a' }, { userId: 'b', basisPoints: 10_000 }], 'a'),
);
expectThrow('empty participants', () => percent.calculate(100, [], 'a'));

// ── SHARES calculator ─────────────────────────────────────────────────────────

console.log('\n· SharesSplitCalculator');

const shares = new SharesSplitCalculator();

{
  // Clean: 3:5:7 of 90 000 minor units — totalUnits = 15, all divide evenly
  const r = shares.calculate(
    90_000,
    [
      { userId: 'alice', shareUnits: 3 },
      { userId: 'bob', shareUnits: 5 },
      { userId: 'carol', shareUnits: 7 },
    ],
    'alice',
  );
  check('3:5:7 alice=18000', r.find((x) => x.userId === 'alice')?.shareMinor === 18_000, r);
  check('3:5:7 bob=30000',   r.find((x) => x.userId === 'bob')?.shareMinor === 30_000);
  check('3:5:7 carol=42000', r.find((x) => x.userId === 'carol')?.shareMinor === 42_000);
  check('shareUnits metadata set', r.every((x) => x.shareUnits !== null && x.basisPoints === null && x.exactAmountMinor === null));
  checkInvariant('shares 3:5:7 clean', r, 90_000);
}

{
  // LRM remainder: 1:2 of 100 minor units — totalUnits=3
  // a: floor(1×100/3) = 33, rem_num = 100 mod 3 = 1
  // b: floor(2×100/3) = 66, rem_num = 200 mod 3 = 2
  // totalFloor=99, extra=1 → b (larger rem) gets extra
  const r = shares.calculate(
    100,
    [{ userId: 'a', shareUnits: 1 }, { userId: 'b', shareUnits: 2 }],
    'a',
  );
  check('1:2 a=33', r.find((x) => x.userId === 'a')?.shareMinor === 33, r);
  check('1:2 b=67', r.find((x) => x.userId === 'b')?.shareMinor === 67, r);
  checkInvariant('shares 1:2', r, 100);
}

{
  // LRM tie-break: equal fractional remainders → userId ASC
  // 1:1 of 1 minor units: a=0, b=0, extra=1 → userId ASC: 'a' < 'b' → 'a' gets extra
  const r = shares.calculate(
    1,
    [{ userId: 'b', shareUnits: 1 }, { userId: 'a', shareUnits: 1 }],
    'a',
  );
  check('1:1 tie-break: a gets extra (a < b)', r.find((x) => x.userId === 'a')?.shareMinor === 1, r);
  check('1:1 tie-break: b gets 0',             r.find((x) => x.userId === 'b')?.shareMinor === 0, r);
  checkInvariant('shares 1:1 tie-break', r, 1);
}

{
  // BigInt overflow safety: large shareUnits × large amountMinor
  // shareUnits = 1_000_000, amountMinor = 100_000_000_000
  // product = 10^17 — exceeds Number.MAX_SAFE_INTEGER, requires BigInt
  const r = shares.calculate(
    100_000_000_000,
    [
      { userId: 'heavy', shareUnits: 1_000_000 },
      { userId: 'light', shareUnits: 1 },
    ],
    'heavy',
  );
  checkInvariant('shares BigInt overflow safety', r, 100_000_000_000);
  // heavy should have almost all the amount
  const heavyShare = r.find((x) => x.userId === 'heavy')?.shareMinor ?? 0;
  check('shares overflow: heavy gets most', heavyShare > 99_900_000_000, { heavyShare });
}

{
  // Single participant
  const r = shares.calculate(12_345, [{ userId: 'only', shareUnits: 999 }], 'only');
  checkInvariant('shares single participant', r, 12_345);
  check('single gets everything', r[0]?.shareMinor === 12_345);
}

console.log('\n· SharesSplitCalculator — invalid input');
expectThrow('shareUnits = 0', () =>
  shares.calculate(100, [{ userId: 'a', shareUnits: 0 }, { userId: 'b', shareUnits: 1 }], 'a'),
);
expectThrow('shareUnits > 1000000', () =>
  shares.calculate(100, [{ userId: 'a', shareUnits: 1_000_001 }], 'a'),
);
expectThrow('missing shareUnits', () =>
  shares.calculate(100, [{ userId: 'a' }, { userId: 'b', shareUnits: 1 }], 'a'),
);
expectThrow('non-integer shareUnits', () =>
  shares.calculate(100, [{ userId: 'a', shareUnits: 1.5 }], 'a'),
);
expectThrow('empty participants', () => shares.calculate(100, [], 'a'));

// ── SplitCalculatorRegistry ───────────────────────────────────────────────────

console.log('\n· SplitCalculatorRegistry');

{
  // Production registry dispatches all four types
  const eqResult = splitRegistry.compute('EQUAL', 90_000, [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }], 'a');
  checkInvariant('registry EQUAL dispatch', eqResult, 90_000);

  const exResult = splitRegistry.compute(
    'EXACT',
    100,
    [{ userId: 'a', exactAmountMinor: 60 }, { userId: 'b', exactAmountMinor: 40 }],
    'a',
  );
  checkInvariant('registry EXACT dispatch', exResult, 100);

  const pctResult = splitRegistry.compute(
    'PERCENT',
    100,
    [{ userId: 'a', basisPoints: 6_000 }, { userId: 'b', basisPoints: 4_000 }],
    'a',
  );
  checkInvariant('registry PERCENT dispatch', pctResult, 100);

  const shrResult = splitRegistry.compute(
    'SHARES',
    100,
    [{ userId: 'a', shareUnits: 3 }, { userId: 'b', shareUnits: 7 }],
    'a',
  );
  checkInvariant('registry SHARES dispatch', shrResult, 100);
}

{
  // Unknown split type throws
  const testRegistry = new SplitCalculatorRegistry();
  expectThrow('unknown type throws', () => testRegistry.compute('EQUAL' as never, 100, [], 'x'));
}

{
  // Duplicate registration throws
  const testRegistry = new SplitCalculatorRegistry();
  testRegistry.register(new EqualSplitCalculator());
  expectThrow('duplicate registration throws', () => testRegistry.register(new EqualSplitCalculator()));
}

// ── Mixed split types on one "trip" (aggregate invariant) ────────────────────

console.log('\n· Mixed split types — aggregate balance invariant');

{
  // Simulate a trip with one expense of each split type.
  // The balance engine receives shareMinor values; the total must be correct.
  const members = ['alice', 'bob', 'carol'];

  const equalExpense = equal.calculate(
    120_000,
    members.map((userId) => ({ userId })),
    'alice',
  );

  const exactExpense = exact.calculate(
    50_000,
    [
      { userId: 'alice', exactAmountMinor: 25_000 },
      { userId: 'bob',   exactAmountMinor: 15_000 },
      { userId: 'carol', exactAmountMinor: 10_000 },
    ],
    'bob',
  );

  const percentExpense = percent.calculate(
    99_999,
    [
      { userId: 'alice', basisPoints: 3_000 },
      { userId: 'bob',   basisPoints: 3_000 },
      { userId: 'carol', basisPoints: 4_000 },
    ],
    'carol',
  );

  const sharesExpense = shares.calculate(
    80_001,
    [
      { userId: 'alice', shareUnits: 1 },
      { userId: 'bob',   shareUnits: 2 },
      { userId: 'carol', shareUnits: 3 },
    ],
    'alice',
  );

  const allExpenses = [equalExpense, exactExpense, percentExpense, sharesExpense];
  const allAmounts = [120_000, 50_000, 99_999, 80_001];

  allExpenses.forEach((results, i) => {
    checkInvariant(`mixed expense[${String(i)}]`, results, allAmounts[i] as number);
  });

  // Verify that the aggregate shareMinor across all participants
  // equals the total amountMinor across all expenses.
  const totalAmount = allAmounts.reduce((a, b) => a + b, 0);
  const totalShareMinor = allExpenses.flatMap((e) => e).reduce((acc, r) => acc + r.shareMinor, 0);
  check(
    'mixed: SUM(shareMinor across all expenses) === SUM(amountMinor)',
    totalShareMinor === totalAmount,
    { totalShareMinor, totalAmount },
  );
}

// ── Result ────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n✘ ${String(failures)} check(s) failed`);
  process.exit(1);
}
console.log('\n✔ all split calculator tests pass');
