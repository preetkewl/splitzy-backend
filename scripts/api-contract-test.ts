/**
 * API contract tests for the Expense module.
 *
 * These tests validate the full validation pipeline — Zod schemas, discriminated
 * union parsing, cross-field refinements, and the TypeScript DTO shapes — without
 * starting a server or touching the database.
 *
 * Coverage:
 *   REQUEST VALIDATION
 *     EQUAL    — implicit (no splitType), explicit, participantIds, uniqueness
 *     EXACT    — valid, sum mismatch, duplicate userId, negative, missing field
 *     PERCENT  — valid, sum mismatch, duplicate userId, range violation, empty
 *     SHARES   — valid, duplicate userId, zero units, max exceeded, missing field
 *
 *   BACKWARD COMPATIBILITY
 *     Old client (no splitType)         → parsed as EQUAL
 *     Old client (null splitType)       → parsed as EQUAL
 *     Old client (participantIds only)  → valid EQUAL
 *
 *   ERROR PATH STRUCTURE
 *     Zod errors emit structured paths matching the error-handler format:
 *       "participants.1.userId" / "participants" / "participantIds.0"
 *
 *   RESPONSE DTO SHAPE
 *     ExpenseDto fields — present and typed correctly (TypeScript compile check)
 *     SplitMetaDto discriminated union — narrowing works as expected
 *     BalanceSummaryDto fields — present and typed correctly
 *
 *   API ENVELOPE SHAPE
 *     SuccessBody<T>  — { success: true, data, meta? }
 *     ErrorBody       — { success: false, error: { code, message, details? } }
 *
 * Run: npx tsx scripts/api-contract-test.ts
 */

import { ExpenseCategory, ExpenseSplitType } from '@prisma/client';
import { ZodError } from 'zod';
import type {
  BalanceSummaryDto,
  ExpenseDto,
  ExactSplitMetaDto,
  MemberBalanceDto,
  PercentSplitMetaDto,
  SettlementSuggestionDto,
  SharesSplitMetaDto,
  SplitMetaDto,
  UserPreviewDto,
} from '../src/modules/expense/dto/index.js';
import type { ApiBody, ErrorBody, SuccessBody } from '../src/core/api-response.js';
import {
  createExpenseBodySchema,
  equalBodySchema,
  exactBodySchema,
  percentBodySchema,
  sharesBodySchema,
} from '../src/modules/expense/validation/index.js';

// ── Test harness ──────────────────────────────────────────────────────────────

let failures = 0;

function heading(name: string): void {
  console.log(`\n· ${name}`);
}

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✘ ${name}`);
    if (detail !== undefined) console.error('    ', JSON.stringify(detail, null, 2));
  }
}

function expectValid<T>(name: string, fn: () => T): T | undefined {
  try {
    const result = fn();
    check(name, true);
    return result;
  } catch (err) {
    check(name, false, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

interface ZodErrorSummary {
  /** Flat map: dotted-path → first error message */
  fields: Record<string, string>;
}

/**
 * Expect the fn to throw a ZodError. Returns a summary of field-level
 * error messages so individual checks can assert specific path+message.
 */
function expectZodError(name: string, fn: () => unknown): ZodErrorSummary {
  try {
    fn();
    check(name, false, 'Expected ZodError but no error was thrown');
    return { fields: {} };
  } catch (err) {
    if (err instanceof ZodError) {
      check(name, true);
      const fields: Record<string, string> = {};
      for (const issue of err.issues) {
        const key = issue.path.join('.') || '_';
        if (!(key in fields)) fields[key] = issue.message;
      }
      return { fields };
    }
    check(name, false, `Expected ZodError but got: ${String(err)}`);
    return { fields: {} };
  }
}

// ── Shared base for all valid requests ───────────────────────────────────────

const TRIP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PAYER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const USER_C = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SPENT_AT = '2026-05-26T13:00:00+05:30';

const baseFields = {
  tripId: TRIP_ID,
  title: 'Test expense',
  amountMinor: 100_000,
  paidByUserId: PAYER_ID,
  category: ExpenseCategory.FOOD,
  spentAt: SPENT_AT,
} as const;

// ── SECTION 1: EQUAL split ────────────────────────────────────────────────────

heading('EQUAL — request validation');

{
  // 1a. Old client: no splitType field, no participants at all
  const result = expectValid('old client (no splitType) → parses as EQUAL', () =>
    createExpenseBodySchema.parse({ ...baseFields }),
  );
  check('splitType injected as EQUAL', result?.splitType === ExpenseSplitType.EQUAL);
  // Narrow to EQUAL branch to access participantIds safely
  const resultEq = result?.splitType === ExpenseSplitType.EQUAL ? result : undefined;
  check('participantIds absent → undefined', resultEq !== undefined && resultEq.participantIds === undefined);
  check('spentAt coerced to Date', result?.spentAt instanceof Date);

  // 1b. Old client: no splitType, but explicit participantIds
  const withIds = expectValid('old client (no splitType, with participantIds)', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      participantIds: [USER_A, USER_B],
    }),
  );
  check('splitType EQUAL', withIds?.splitType === ExpenseSplitType.EQUAL);
  // Narrow to EQUAL branch to access participantIds
  const withIdsEq = withIds?.splitType === ExpenseSplitType.EQUAL ? withIds : undefined;
  check('participantIds preserved', JSON.stringify(withIdsEq?.participantIds) === JSON.stringify([USER_A, USER_B]));

  // 1c. Explicit EQUAL, no participantIds (all-members default)
  const explicit = expectValid('explicit EQUAL, no participantIds', () =>
    createExpenseBodySchema.parse({ ...baseFields, splitType: 'EQUAL' }),
  );
  check('splitType EQUAL', explicit?.splitType === ExpenseSplitType.EQUAL);

  // 1d. null splitType → treated as absent → EQUAL
  const nullType = expectValid('null splitType → EQUAL', () =>
    createExpenseBodySchema.parse({ ...baseFields, splitType: null }),
  );
  check('splitType EQUAL after null injection', nullType?.splitType === ExpenseSplitType.EQUAL);

  // 1e. Duplicate in participantIds → ZodError with path
  const dupErr = expectZodError('duplicate participantIds → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'EQUAL',
      participantIds: [USER_A, USER_B, USER_A],
    }),
  );
  check(
    'path is participantIds.2',
    'participantIds.2' in dupErr.fields,
    dupErr.fields,
  );
  check(
    'message mentions duplicate',
    dupErr.fields['participantIds.2']?.includes('Duplicate') ?? false,
    dupErr.fields,
  );

  // 1f. Missing required field (title)
  const noTitle = expectZodError('missing title → ZodError', () =>
    createExpenseBodySchema.parse({ ...baseFields, title: undefined }),
  );
  check('path is title', 'title' in noTitle.fields || '_' in noTitle.fields, noTitle.fields);

  // 1g. Non-integer amountMinor
  const floatAmount = expectZodError('decimal amountMinor → ZodError', () =>
    createExpenseBodySchema.parse({ ...baseFields, amountMinor: 1000.5 }),
  );
  check('path is amountMinor', 'amountMinor' in floatAmount.fields, floatAmount.fields);

  // 1h. spentAt as ISO string → transformed to Date
  const parsed = createExpenseBodySchema.safeParse({ ...baseFields, splitType: 'EQUAL' });
  check('spentAt parsed to Date', parsed.success && parsed.data.spentAt instanceof Date);

  // 1i. spentAt as Date object → also valid
  const withDate = createExpenseBodySchema.safeParse({
    ...baseFields,
    splitType: 'EQUAL',
    spentAt: new Date('2026-05-26T13:00:00.000Z'),
  });
  check('spentAt as Date object accepted', withDate.success && withDate.data.spentAt instanceof Date);
}

// ── SECTION 2: EXACT split ────────────────────────────────────────────────────

heading('EXACT — request validation');

{
  const participants = [
    { userId: USER_A, exactAmountMinor: 60_000 },
    { userId: USER_B, exactAmountMinor: 40_000 },
  ];

  // 2a. Valid EXACT
  const result = expectValid('valid EXACT — sum matches amountMinor', () =>
    createExpenseBodySchema.parse({ ...baseFields, splitType: 'EXACT', participants }),
  );
  check('splitType EXACT', result?.splitType === ExpenseSplitType.EXACT);
  check('participants preserved', result !== undefined && 'participants' in result);

  // 2b. Sum mismatch: total < amountMinor
  const lowSum = expectZodError('EXACT sum too low → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'EXACT',
      participants: [
        { userId: USER_A, exactAmountMinor: 50_000 },
        { userId: USER_B, exactAmountMinor: 40_000 }, // sum = 90 000, not 100 000
      ],
    }),
  );
  check('path is participants', 'participants' in lowSum.fields, lowSum.fields);
  check('message mentions minor units diff', lowSum.fields['participants']?.includes('difference') ?? false, lowSum.fields);

  // 2c. Sum mismatch: total > amountMinor
  const highSum = expectZodError('EXACT sum too high → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'EXACT',
      participants: [
        { userId: USER_A, exactAmountMinor: 70_000 },
        { userId: USER_B, exactAmountMinor: 40_000 }, // sum = 110 000
      ],
    }),
  );
  check('path is participants', 'participants' in highSum.fields, highSum.fields);

  // 2d. Duplicate userId in participants
  const dupErr = expectZodError('EXACT duplicate userId → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'EXACT',
      participants: [
        { userId: USER_A, exactAmountMinor: 50_000 },
        { userId: USER_A, exactAmountMinor: 50_000 }, // duplicate
      ],
    }),
  );
  check('path is participants.1.userId', 'participants.1.userId' in dupErr.fields, dupErr.fields);
  check('message mentions Duplicate', dupErr.fields['participants.1.userId']?.includes('Duplicate') ?? false, dupErr.fields);

  // 2e. Negative exactAmountMinor
  const negErr = expectZodError('negative exactAmountMinor → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'EXACT',
      participants: [
        { userId: USER_A, exactAmountMinor: -1 },
        { userId: USER_B, exactAmountMinor: 101_000 },
      ],
    }),
  );
  check('path is participants.0.exactAmountMinor', 'participants.0.exactAmountMinor' in negErr.fields, negErr.fields);

  // 2f. Missing exactAmountMinor field
  const missingField = expectZodError('missing exactAmountMinor → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'EXACT',
      participants: [{ userId: USER_A }], // no exactAmountMinor
    }),
  );
  check('path contains exactAmountMinor', Object.keys(missingField.fields).some((k) => k.includes('exactAmountMinor')), missingField.fields);

  // 2g. Empty participants array
  const emptyErr = expectZodError('empty participants → ZodError', () =>
    createExpenseBodySchema.parse({ ...baseFields, splitType: 'EXACT', participants: [] }),
  );
  check('path is participants', 'participants' in emptyErr.fields, emptyErr.fields);

  // 2h. Payer with exactAmountMinor = 0 is valid (covers others entirely)
  const payerZero = expectValid('payer exactAmountMinor = 0 is valid', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'EXACT',
      participants: [
        { userId: PAYER_ID, exactAmountMinor: 0 },
        { userId: USER_A, exactAmountMinor: 100_000 },
      ],
    }),
  );
  check('parsed successfully', payerZero !== undefined);
}

// ── SECTION 3: PERCENT split ──────────────────────────────────────────────────

heading('PERCENT — request validation');

{
  const participants = [
    { userId: USER_A, basisPoints: 5000 }, // 50%
    { userId: USER_B, basisPoints: 2500 }, // 25%
    { userId: USER_C, basisPoints: 2500 }, // 25%
  ];

  // 3a. Valid PERCENT
  const result = expectValid('valid PERCENT — sum = 10000', () =>
    createExpenseBodySchema.parse({ ...baseFields, splitType: 'PERCENT', participants }),
  );
  check('splitType PERCENT', result?.splitType === ExpenseSplitType.PERCENT);
  check('participants preserved', result !== undefined && 'participants' in result);

  // 3b. Sum < 10000
  const lowSum = expectZodError('PERCENT sum < 10000 → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'PERCENT',
      participants: [
        { userId: USER_A, basisPoints: 5000 },
        { userId: USER_B, basisPoints: 4999 }, // sum = 9999
      ],
    }),
  );
  check('path is participants', 'participants' in lowSum.fields, lowSum.fields);
  check('message mentions 10000', lowSum.fields['participants']?.includes('10000') ?? false, lowSum.fields);

  // 3c. Sum > 10000
  const highSum = expectZodError('PERCENT sum > 10000 → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'PERCENT',
      participants: [
        { userId: USER_A, basisPoints: 5001 },
        { userId: USER_B, basisPoints: 5000 }, // sum = 10001
      ],
    }),
  );
  check('path is participants', 'participants' in highSum.fields, highSum.fields);

  // 3d. Duplicate userId
  const dupErr = expectZodError('PERCENT duplicate userId → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'PERCENT',
      participants: [
        { userId: USER_A, basisPoints: 5000 },
        { userId: USER_A, basisPoints: 5000 }, // duplicate
      ],
    }),
  );
  check('path is participants.1.userId', 'participants.1.userId' in dupErr.fields, dupErr.fields);

  // 3e. basisPoints = 0 (below minimum of 1)
  const zeroErr = expectZodError('basisPoints = 0 → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'PERCENT',
      participants: [
        { userId: USER_A, basisPoints: 0 },
        { userId: USER_B, basisPoints: 10000 },
      ],
    }),
  );
  check('path is participants.0.basisPoints', 'participants.0.basisPoints' in zeroErr.fields, zeroErr.fields);

  // 3f. basisPoints > 10000
  const overMax = expectZodError('basisPoints > 10000 → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'PERCENT',
      participants: [{ userId: USER_A, basisPoints: 10001 }],
    }),
  );
  check('path is participants.0.basisPoints', 'participants.0.basisPoints' in overMax.fields, overMax.fields);

  // 3g. Missing basisPoints
  const missingBp = expectZodError('missing basisPoints → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'PERCENT',
      participants: [{ userId: USER_A }],
    }),
  );
  check('path contains basisPoints', Object.keys(missingBp.fields).some((k) => k.includes('basisPoints')), missingBp.fields);

  // 3h. Empty participants
  const emptyErr = expectZodError('empty participants → ZodError', () =>
    createExpenseBodySchema.parse({ ...baseFields, splitType: 'PERCENT', participants: [] }),
  );
  check('path is participants', 'participants' in emptyErr.fields, emptyErr.fields);

  // 3i. Single participant at 100% (10000 bp) — valid
  const single = expectValid('single participant at 10000 bp is valid', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'PERCENT',
      participants: [{ userId: USER_A, basisPoints: 10_000 }],
    }),
  );
  check('parsed successfully', single !== undefined);

  // 3j. Non-integer basisPoints
  const floatBp = expectZodError('non-integer basisPoints → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'PERCENT',
      participants: [{ userId: USER_A, basisPoints: 5000.5 }],
    }),
  );
  check('path contains basisPoints', Object.keys(floatBp.fields).some((k) => k.includes('basisPoints')), floatBp.fields);
}

// ── SECTION 4: SHARES split ───────────────────────────────────────────────────

heading('SHARES — request validation');

{
  const participants = [
    { userId: USER_A, shareUnits: 3 },
    { userId: USER_B, shareUnits: 5 },
    { userId: USER_C, shareUnits: 7 },
  ];

  // 4a. Valid SHARES
  const result = expectValid('valid SHARES — 3:5:7', () =>
    createExpenseBodySchema.parse({ ...baseFields, splitType: 'SHARES', participants }),
  );
  check('splitType SHARES', result?.splitType === ExpenseSplitType.SHARES);

  // 4b. Duplicate userId
  const dupErr = expectZodError('SHARES duplicate userId → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'SHARES',
      participants: [
        { userId: USER_A, shareUnits: 3 },
        { userId: USER_A, shareUnits: 5 }, // duplicate
      ],
    }),
  );
  check('path is participants.1.userId', 'participants.1.userId' in dupErr.fields, dupErr.fields);

  // 4c. shareUnits = 0
  const zeroErr = expectZodError('shareUnits = 0 → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'SHARES',
      participants: [{ userId: USER_A, shareUnits: 0 }],
    }),
  );
  check('path is participants.0.shareUnits', 'participants.0.shareUnits' in zeroErr.fields, zeroErr.fields);

  // 4d. shareUnits > 1 000 000
  const overMax = expectZodError('shareUnits > 1000000 → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'SHARES',
      participants: [{ userId: USER_A, shareUnits: 1_000_001 }],
    }),
  );
  check('path is participants.0.shareUnits', 'participants.0.shareUnits' in overMax.fields, overMax.fields);

  // 4e. Missing shareUnits
  const missingUnits = expectZodError('missing shareUnits → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'SHARES',
      participants: [{ userId: USER_A }],
    }),
  );
  check('path contains shareUnits', Object.keys(missingUnits.fields).some((k) => k.includes('shareUnits')), missingUnits.fields);

  // 4f. Non-integer shareUnits
  const floatUnits = expectZodError('non-integer shareUnits → ZodError', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'SHARES',
      participants: [{ userId: USER_A, shareUnits: 1.5 }],
    }),
  );
  check('path contains shareUnits', Object.keys(floatUnits.fields).some((k) => k.includes('shareUnits')), floatUnits.fields);

  // 4g. Empty participants
  const emptyErr = expectZodError('empty participants → ZodError', () =>
    createExpenseBodySchema.parse({ ...baseFields, splitType: 'SHARES', participants: [] }),
  );
  check('path is participants', 'participants' in emptyErr.fields, emptyErr.fields);

  // 4h. Single participant (no sum constraint — always valid)
  const single = expectValid('single participant is valid', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'SHARES',
      participants: [{ userId: USER_A, shareUnits: 1 }],
    }),
  );
  check('parsed successfully', single !== undefined);

  // 4i. No cross-participant sum constraint — any totals ok
  const bigUnits = expectValid('large units with no sum constraint', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'SHARES',
      participants: [
        { userId: USER_A, shareUnits: 1_000_000 },
        { userId: USER_B, shareUnits: 1_000_000 },
      ],
    }),
  );
  check('parsed successfully', bigUnits !== undefined);
}

// ── SECTION 5: Backward compatibility ────────────────────────────────────────

heading('Backward compatibility');

{
  // 5a. Completely old-client payload (no splitType, no participants)
  const old1 = createExpenseBodySchema.safeParse({ ...baseFields });
  check('no splitType → success', old1.success);
  check('no splitType → splitType=EQUAL', old1.success && old1.data.splitType === ExpenseSplitType.EQUAL);

  // 5b. Old client with participantIds (pre-dates advanced splits)
  const old2 = createExpenseBodySchema.safeParse({
    ...baseFields,
    participantIds: [USER_A, USER_B, USER_C],
  });
  check('old participantIds → success', old2.success);
  check('old participantIds → splitType=EQUAL', old2.success && old2.data.splitType === ExpenseSplitType.EQUAL);
  // Narrow to EQUAL branch before accessing participantIds
  const old2Eq = old2.success && old2.data.splitType === ExpenseSplitType.EQUAL ? old2.data : undefined;
  check(
    'old participantIds → preserved',
    JSON.stringify(old2Eq?.participantIds) === JSON.stringify([USER_A, USER_B, USER_C]),
  );

  // 5c. null splitType → treated as absent → EQUAL
  const old3 = createExpenseBodySchema.safeParse({ ...baseFields, splitType: null });
  check('null splitType → success', old3.success);
  check('null splitType → splitType=EQUAL', old3.success && old3.data.splitType === ExpenseSplitType.EQUAL);

  // 5d. Unknown splitType string → rejected (not silently coerced)
  const unknown = createExpenseBodySchema.safeParse({ ...baseFields, splitType: 'CUSTOM' });
  check('unknown splitType → rejected', !unknown.success);

  // 5e. category is optional — old clients that never sent it are ok
  const noCategory = createExpenseBodySchema.safeParse({
    tripId: TRIP_ID,
    title: 'No category',
    amountMinor: 50_000,
    paidByUserId: PAYER_ID,
    spentAt: SPENT_AT,
    // no category, no splitType
  });
  check('missing category → success (defaults in service)', noCategory.success);
  check('missing splitType + category → EQUAL', noCategory.success && noCategory.data.splitType === ExpenseSplitType.EQUAL);
}

// ── SECTION 6: Zod error path structure (error-handler format) ───────────────

heading('Zod error path structure (matches error-handler fields map)');

{
  // Verify the exact path strings the error-handler would produce as JSON keys.
  // The error handler does: path.join('.') || '_'

  // 6a. EXACT sum mismatch → "participants"
  const exactSum = expectZodError('EXACT sum mismatch path = "participants"', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'EXACT',
      participants: [
        { userId: USER_A, exactAmountMinor: 50_000 },
        { userId: USER_B, exactAmountMinor: 45_000 }, // sum = 95000 ≠ 100000
      ],
    }),
  );
  check('"participants" key present', 'participants' in exactSum.fields, exactSum.fields);
  check('message contains "EXACT:"', exactSum.fields['participants']?.startsWith('EXACT:') ?? false, exactSum.fields);
  check('message contains "difference"', exactSum.fields['participants']?.includes('difference') ?? false, exactSum.fields);

  // 6b. PERCENT sum mismatch → "participants"
  const pctSum = expectZodError('PERCENT sum mismatch path = "participants"', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'PERCENT',
      participants: [
        { userId: USER_A, basisPoints: 4999 },
        { userId: USER_B, basisPoints: 5000 }, // sum = 9999
      ],
    }),
  );
  check('"participants" key present', 'participants' in pctSum.fields, pctSum.fields);
  check('message contains "PERCENT:"', pctSum.fields['participants']?.startsWith('PERCENT:') ?? false, pctSum.fields);
  check('message contains percentage', pctSum.fields['participants']?.includes('%') ?? false, pctSum.fields);

  // 6c. Duplicate EQUAL participantIds → "participantIds.N"
  const eqDup = expectZodError('EQUAL duplicate → path "participantIds.N"', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'EQUAL',
      participantIds: [USER_A, USER_A],
    }),
  );
  check('"participantIds.1" key present', 'participantIds.1' in eqDup.fields, eqDup.fields);

  // 6d. Duplicate EXACT participant → "participants.N.userId"
  const exDup = expectZodError('EXACT duplicate → path "participants.N.userId"', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'EXACT',
      participants: [
        { userId: USER_A, exactAmountMinor: 50_000 },
        { userId: USER_A, exactAmountMinor: 50_000 },
      ],
    }),
  );
  check('"participants.1.userId" key present', 'participants.1.userId' in exDup.fields, exDup.fields);

  // 6e. Duplicate PERCENT participant → "participants.N.userId"
  const pDup = expectZodError('PERCENT duplicate → path "participants.N.userId"', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'PERCENT',
      participants: [
        { userId: USER_A, basisPoints: 5000 },
        { userId: USER_A, basisPoints: 5000 },
      ],
    }),
  );
  check('"participants.1.userId" key present', 'participants.1.userId' in pDup.fields, pDup.fields);

  // 6f. Duplicate SHARES participant → "participants.N.userId"
  const sDup = expectZodError('SHARES duplicate → path "participants.N.userId"', () =>
    createExpenseBodySchema.parse({
      ...baseFields,
      splitType: 'SHARES',
      participants: [
        { userId: USER_A, shareUnits: 3 },
        { userId: USER_A, shareUnits: 5 },
      ],
    }),
  );
  check('"participants.1.userId" key present', 'participants.1.userId' in sDup.fields, sDup.fields);
}

// ── SECTION 7: Response DTO shape (TypeScript compile-time checks) ────────────

heading('Response DTO shape (TypeScript type assertions)');

{
  // These are pure TypeScript type checks. If they compile, the shapes are correct.
  // At runtime we just verify that the interface allows the values we construct.

  const userPreview: UserPreviewDto = {
    userId: USER_A,
    name: 'Anjali Sharma',
    avatarColor: '#4A90D9',
    avatarUrl: null,
  };

  const exactMeta: ExactSplitMetaDto = {
    type: 'EXACT',
    participants: { [USER_A]: 60_000, [USER_B]: 40_000 },
  };
  const percentMeta: PercentSplitMetaDto = {
    type: 'PERCENT',
    participants: { [USER_A]: 5000, [USER_B]: 5000 },
  };
  const sharesMeta: SharesSplitMetaDto = {
    type: 'SHARES',
    participants: { [USER_A]: 3, [USER_B]: 7 },
  };

  // SplitMetaDto union narrowing
  function describeMeta(meta: SplitMetaDto): string {
    switch (meta.type) {
      case 'EXACT':   return `exact with ${Object.keys(meta.participants).length} participants`;
      case 'PERCENT': return `percent with ${Object.keys(meta.participants).length} participants`;
      case 'SHARES':  return `shares with ${Object.keys(meta.participants).length} participants`;
    }
  }

  check('ExactSplitMetaDto narrows correctly',
    describeMeta(exactMeta).startsWith('exact'));
  check('PercentSplitMetaDto narrows correctly',
    describeMeta(percentMeta).startsWith('percent'));
  check('SharesSplitMetaDto narrows correctly',
    describeMeta(sharesMeta).startsWith('shares'));

  // ExpenseDto — EQUAL expense (null splitMeta)
  const equalExpense: ExpenseDto = {
    id: 'e1-uuid',
    tripId: TRIP_ID,
    title: 'Team lunch',
    amountMinor: 120_000,
    category: ExpenseCategory.FOOD,
    splitType: ExpenseSplitType.EQUAL,
    paidBy: userPreview,
    payments: [{ user: userPreview, contributionMinor: 120_000 }],
    participants: [
      {
        ...userPreview,
        shareMinor: 40_000,
        basisPoints: null,
        shareUnits: null,
        exactAmountMinor: null,
      },
    ],
    splitMeta: null, // EQUAL → null
    spentAt: '2026-05-26T13:00:00.000Z',
    createdAt: '2026-05-26T14:00:00.000Z',
    updatedAt: '2026-05-26T14:00:00.000Z',
    canDelete: true,
  };
  check('ExpenseDto (EQUAL) constructs correctly', equalExpense.splitType === ExpenseSplitType.EQUAL);
  check('ExpenseDto (EQUAL) splitMeta is null', equalExpense.splitMeta === null);

  // ExpenseDto — PERCENT expense (typed splitMeta)
  const percentExpense: ExpenseDto = {
    ...equalExpense,
    splitType: ExpenseSplitType.PERCENT,
    participants: [
      { ...userPreview, shareMinor: 60_000, basisPoints: 5000, shareUnits: null, exactAmountMinor: null },
      { ...userPreview, userId: USER_B, name: 'Rohan', shareMinor: 60_000, basisPoints: 5000, shareUnits: null, exactAmountMinor: null },
    ],
    splitMeta: percentMeta,
  };
  check('ExpenseDto (PERCENT) splitMeta is PercentSplitMetaDto', percentExpense.splitMeta?.type === 'PERCENT');
  check('basisPoints populated', percentExpense.participants[0]?.basisPoints === 5000);
  check('shareUnits null', percentExpense.participants[0]?.shareUnits === null);

  // MemberBalanceDto
  const memberBalance: MemberBalanceDto = {
    ...userPreview,
    netMinor: 80_000,
    totalPaidMinor: 200_000,
    totalShareMinor: 120_000,
    isCurrentMember: true,
  };
  check('MemberBalanceDto constructs correctly', memberBalance.netMinor === 80_000);

  // SettlementSuggestionDto
  const suggestion: SettlementSuggestionDto = {
    fromUserId: USER_B,
    toUserId: USER_A,
    amountMinor: 80_000,
  };
  check('SettlementSuggestionDto constructs correctly', suggestion.amountMinor === 80_000);

  // BalanceSummaryDto
  const balanceSummary: BalanceSummaryDto = {
    totalAmountMinor: 300_000,
    totalReimbursedMinor: 0,
    members: [memberBalance],
    suggestedTransfers: [suggestion],
  };
  check('BalanceSummaryDto constructs correctly', balanceSummary.members.length === 1);
}

// ── SECTION 8: API envelope shape ────────────────────────────────────────────

heading('API envelope shape');

{
  // SuccessBody<T> — { success: true, data: T, meta?: ResponseMeta }
  const successWithData: SuccessBody<ExpenseDto[]> = {
    success: true,
    data: [],
  };
  check('SuccessBody success=true', successWithData.success === true);
  check('SuccessBody has data', Array.isArray(successWithData.data));
  check('SuccessBody meta absent is ok', successWithData.meta === undefined);

  const successWithMeta: SuccessBody<ExpenseDto[]> = {
    success: true,
    data: [],
    meta: { page: 1, pageSize: 20, total: 0 },
  };
  check('SuccessBody with pagination meta', successWithMeta.meta?.total === 0);

  // ErrorBody — { success: false, error: { code, message, details? } }
  const errorWithDetails: ErrorBody = {
    success: false,
    error: {
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      details: {
        fields: {
          'participants.1.userId': ['Duplicate userId: "abc" appears more than once'],
          participants: ['EXACT: exactAmountMinor values sum to 90000 minor units but amountMinor is 100000 minor units (difference: -10000 minor units).'],
        },
      },
    },
  };
  check('ErrorBody success=false', errorWithDetails.success === false);
  check('ErrorBody has code', errorWithDetails.error.code === 'VALIDATION_FAILED');
  check('ErrorBody has details', errorWithDetails.error.details !== undefined);

  // ApiBody<T> discriminated union — TypeScript narrowing
  function handleApiBody(body: ApiBody<string>): string {
    if (body.success) {
      return `ok: ${body.data}`;
    }
    return `err: ${body.error.message}`;
  }
  check('ApiBody<T> narrows success branch',
    handleApiBody({ success: true, data: 'hello' }) === 'ok: hello');
  check('ApiBody<T> narrows error branch',
    handleApiBody({ success: false, error: { code: 'BAD_REQUEST', message: 'bad' } }) === 'err: bad');
}

// ── SECTION 9: Branch schema isolation ───────────────────────────────────────

heading('Branch schemas (isolated parsing)');

{
  // The exported branch schemas are useful for tests that want to parse
  // one branch in isolation without the full discriminated union.

  // equalBodySchema
  const eq = equalBodySchema.safeParse({
    ...baseFields,
    splitType: 'EQUAL',
    participantIds: [USER_A],
  });
  check('equalBodySchema parses EQUAL', eq.success);

  // exactBodySchema
  const ex = exactBodySchema.safeParse({
    ...baseFields,
    splitType: 'EXACT',
    participants: [{ userId: USER_A, exactAmountMinor: 100_000 }],
  });
  check('exactBodySchema parses EXACT (no sum check in branch)', ex.success);
  // Note: sum check is on the full discriminated union, not the branch alone.

  // percentBodySchema
  const pct = percentBodySchema.safeParse({
    ...baseFields,
    splitType: 'PERCENT',
    participants: [{ userId: USER_A, basisPoints: 10_000 }],
  });
  check('percentBodySchema parses PERCENT (no sum check in branch)', pct.success);

  // sharesBodySchema
  const shr = sharesBodySchema.safeParse({
    ...baseFields,
    splitType: 'SHARES',
    participants: [{ userId: USER_A, shareUnits: 1 }],
  });
  check('sharesBodySchema parses SHARES', shr.success);

  // Branch schemas reject wrong splitType literal
  const wrongType = equalBodySchema.safeParse({
    ...baseFields,
    splitType: 'EXACT', // wrong branch
    participantIds: [USER_A],
  });
  check('equalBodySchema rejects EXACT literal', !wrongType.success);
}

// ── Result ────────────────────────────────────────────────────────────────────

console.log('');
if (failures === 0) {
  console.log('✔ all API contract tests pass');
} else {
  console.error(`✘ ${String(failures)} test(s) failed`);
  process.exit(1);
}
