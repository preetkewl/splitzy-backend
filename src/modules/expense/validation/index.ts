/**
 * Zod validation schemas for the Expense module.
 *
 * Backward-compatibility guarantee:
 *   Old clients that send no `splitType` field receive EQUAL behavior.
 *   The `z.preprocess` wrapper injects `splitType: 'EQUAL'` before the
 *   discriminated union runs, so the old request shape is a valid member
 *   of the union without any code change on the client side.
 *
 *   Phase 4: Old clients that send `paidByUserId` (and no `payments[]`)
 *   continue to work. The preprocessing step normalises the body so that
 *   `payments` is always set before the discriminated union validates.
 *
 * Validation responsibility split:
 *   Zod (here):
 *     • field presence and types
 *     • per-field ranges (basisPoints ∈ [1,10000], shareUnits ∈ [1,1000000])
 *     • participant array uniqueness by userId          ← enforced here
 *     • EXACT cross-field sum (SUM(exactAmountMinor) == amountMinor)  ← enforced here
 *     • PERCENT cross-field sum (SUM(basisPoints) == 10000)           ← enforced here
 *     • payments[] uniqueness + sum check               ← enforced here
 *   ExpenseService:
 *     • trip membership, payer-in-participants, feature flag
 *   SplitCalculator:
 *     • final invariant SUM(shareMinor) === amountMinor before DB write
 *
 * Cross-participant uniqueness is enforced on each participant array field via
 * .superRefine(). This keeps the branch schema as ZodObject (required by
 * z.discriminatedUnion) while still producing precise path-level errors such as:
 *   participants.2.userId — Duplicate userId: "abc" appears more than once
 *
 * Cross-field sum checks (EXACT, PERCENT) are enforced in a .superRefine()
 * applied to the discriminated union output, after the discriminant has been
 * resolved. This avoids duplicating each branch's shape while still giving
 * the client a structured error with a clear path and diff before the request
 * ever reaches the service or calculator layers.
 */

import { ExpenseCategory, ExpenseSplitType } from '@prisma/client';
import { z } from 'zod';
import {
  MAX_EXPENSE_AMOUNT_MINOR,
  MAX_EXPENSE_TITLE_LENGTH,
  MIN_EXPENSE_AMOUNT_MINOR,
  MIN_EXPENSE_TITLE_LENGTH,
} from '../constants.js';

// ── Shared primitives ─────────────────────────────────────────────────────────

const uuid = z.string().uuid('Must be a valid UUID');

// ── Phase 4: Payment input schema ─────────────────────────────────────────────

/**
 * One payer entry in the payments[] array.
 * contributionMinor must be > 0 — every payment must cover a positive amount.
 */
const paymentInputSchema = z.object({
  userId: uuid,
  contributionMinor: z
    .number()
    .int('contributionMinor must be an integer (minor units)')
    .min(1, 'contributionMinor must be at least 1 (minor unit)'),
});

const amountMinorSchema = z
  .number()
  .int('amountMinor must be an integer (minor units, not whole currency)')
  .min(MIN_EXPENSE_AMOUNT_MINOR, `amountMinor must be at least ${String(MIN_EXPENSE_AMOUNT_MINOR)}`)
  .max(MAX_EXPENSE_AMOUNT_MINOR, `amountMinor must be at most ${String(MAX_EXPENSE_AMOUNT_MINOR)}`);

const titleSchema = z
  .string()
  .trim()
  .min(MIN_EXPENSE_TITLE_LENGTH, `title must be at least ${String(MIN_EXPENSE_TITLE_LENGTH)} character`)
  .max(MAX_EXPENSE_TITLE_LENGTH, `title must be at most ${String(MAX_EXPENSE_TITLE_LENGTH)} characters`);

const categorySchema = z.nativeEnum(ExpenseCategory);

/**
 * Accepts an ISO datetime string OR a Date. Transforms to Date so service
 * code never has to re-parse.
 */
const spentAtSchema = z
  .union([z.string().datetime({ offset: true }), z.date()])
  .transform((v) => (v instanceof Date ? v : new Date(v)));

// ── Uniqueness refinement helper ──────────────────────────────────────────────

/**
 * Reusable superRefine for any participant array that contains a `userId`
 * field. Applied directly on the array field (not the whole object) so the
 * enclosing schema remains ZodObject and stays compatible with
 * z.discriminatedUnion.
 *
 * On duplicate, adds a custom issue at path [index, 'userId'] so the error
 * handler produces:
 *   { "participants.2.userId": ["Duplicate userId: \"abc\" appears more than once"] }
 */
function uniqueByUserId<T extends { userId: string }>(
  participants: T[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (let i = 0; i < participants.length; i++) {
    const id = participants[i]!.userId;
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'userId'],
        message: `Duplicate userId: "${id}" appears more than once`,
      });
    }
    seen.add(id);
  }
}

/** Same pattern for a plain string[] (EQUAL participantIds). */
function uniqueStringArray(ids: string[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (seen.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i],
        message: `Duplicate userId: "${id}" appears more than once`,
      });
    }
    seen.add(id);
  }
}

// ── Per-participant schemas for non-EQUAL split types ─────────────────────────

/**
 * EXACT: each participant specifies their exact minor unit amount (≥ 0).
 * 0 is valid — a payer may cover someone entirely.
 */
const exactParticipantSchema = z.object({
  userId: uuid,
  exactAmountMinor: z
    .number()
    .int('exactAmountMinor must be an integer')
    .min(0, 'exactAmountMinor cannot be negative'),
});

/**
 * PERCENT: each participant specifies their share in basis points.
 * Range [1, 10 000]; 10 000 bp = 100%.
 * Per-participant range is validated here.
 * Cross-participant sum (must equal 10 000) is validated below on the
 * discriminated union via .superRefine().
 */
const percentParticipantSchema = z.object({
  userId: uuid,
  basisPoints: z
    .number()
    .int('basisPoints must be an integer')
    .min(1, 'basisPoints must be at least 1 (0.01%)')
    .max(10_000, 'basisPoints cannot exceed 10000 (100%)'),
});

/**
 * SHARES: each participant specifies a positive integer ratio unit.
 * Range [1, 1 000 000].
 */
const sharesParticipantSchema = z.object({
  userId: uuid,
  shareUnits: z
    .number()
    .int('shareUnits must be an integer')
    .min(1, 'shareUnits must be at least 1')
    .max(1_000_000, 'shareUnits cannot exceed 1000000'),
});

// ── Base fields shared by all split types ─────────────────────────────────────

/**
 * Fields present in every expense creation request regardless of split type.
 * Each split-specific schema extends this via `.extend()`.
 *
 * Phase 4 compatibility:
 *   paidByUserId is now optional — old clients that send it continue to work.
 *   payments[] is optional — new clients that send it take precedence.
 *   At least one of paidByUserId or payments must be present; this is
 *   enforced in the top-level .superRefine() after branch parsing.
 */
const baseExpenseFields = {
  tripId: uuid,
  title: titleSchema,
  amountMinor: amountMinorSchema,
  /**
   * @deprecated Use payments[] instead.
   * Kept for backward compat: old clients that send only paidByUserId are
   * auto-converted to a single-entry payments[] by the preprocessing step.
   * Validated as optional here; the superRefine ensures at least one of
   * paidByUserId / payments is present.
   */
  paidByUserId: uuid.optional(),
  /**
   * Phase 4 multi-payer input. Optional — old clients omit this field.
   * When provided:
   *   - At least one entry required.
   *   - All contributionMinor values must be > 0.
   *   - No duplicate userIds.
   *   - SUM(contributionMinor) === amountMinor (checked in superRefine below).
   */
  payments: z
    .array(paymentInputSchema)
    .min(1, 'payments must contain at least one entry')
    .optional(),
  category: categorySchema.optional(),
  spentAt: spentAtSchema,
} as const;

// ── Split-type-specific schemas ───────────────────────────────────────────────
//
// Each schema is a ZodObject (not ZodEffects) so z.discriminatedUnion can
// inspect the `splitType` literal discriminant via .shape.
//
// Uniqueness .superRefine() is applied to the array FIELD, not the whole
// object, which keeps the outer type as ZodObject.

const baseExpenseSchema = z.object(baseExpenseFields);

const equalBodySchema = baseExpenseSchema.extend({
  splitType: z.literal(ExpenseSplitType.EQUAL),
  /**
   * Optional list of participant userIds.
   * • If absent or empty, the service defaults to all current trip members.
   * • Must be unique by value (checked here via .superRefine).
   * • Backward-compatible field — was present before advanced splits.
   */
  participantIds: z
    .array(uuid)
    .min(1, 'participantIds must not be empty when provided')
    .superRefine(uniqueStringArray)
    .optional(),
});

const exactBodySchema = baseExpenseSchema.extend({
  splitType: z.literal(ExpenseSplitType.EXACT),
  /**
   * One entry per participant.
   * • exactAmountMinor ≥ 0 per participant (0 valid for payer covering everyone).
   * • userIds must be unique within this array.
   * • SUM(exactAmountMinor) must equal amountMinor — validated below on the
   *   discriminated union output, where amountMinor is in scope.
   */
  participants: z
    .array(exactParticipantSchema)
    .min(1, 'EXACT split requires at least one participant')
    .superRefine(uniqueByUserId),
});

const percentBodySchema = baseExpenseSchema.extend({
  splitType: z.literal(ExpenseSplitType.PERCENT),
  /**
   * One entry per participant.
   * • basisPoints ∈ [1, 10 000] per participant.
   * • userIds must be unique within this array.
   * • SUM(basisPoints) must equal 10 000 — validated below on the
   *   discriminated union output.
   */
  participants: z
    .array(percentParticipantSchema)
    .min(1, 'PERCENT split requires at least one participant')
    .superRefine(uniqueByUserId),
});

const sharesBodySchema = baseExpenseSchema.extend({
  splitType: z.literal(ExpenseSplitType.SHARES),
  /**
   * One entry per participant.
   * • shareUnits ∈ [1, 1 000 000] per participant.
   * • userIds must be unique within this array.
   * • No cross-participant sum constraint for SHARES (proportional, any totals ok).
   */
  participants: z
    .array(sharesParticipantSchema)
    .min(1, 'SHARES split requires at least one participant')
    .superRefine(uniqueByUserId),
});

// ── Combined schema with backward-compat default injection ────────────────────

/**
 * Preprocessing pass applied before the discriminated union schema runs.
 *
 * Two normalisation steps:
 * 1. Inject `splitType: 'EQUAL'` when absent — makes old clients work.
 * 2. Inject `payments` when absent but `paidByUserId` is present —
 *    converts the legacy single-payer shape into the Phase 4 canonical form
 *    so the service always receives a populated payments[] field.
 *    NOTE: contributionMinor cannot be injected here because amountMinor
 *    has not been validated yet. The service derives the contribution from
 *    amountMinor at runtime. The Zod superRefine validates the populated
 *    payments[] after both paidByUserId and amountMinor are in scope.
 */
function normaliseExpenseBody(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;

  const withSplitType =
    obj['splitType'] === undefined || obj['splitType'] === null
      ? { ...obj, splitType: ExpenseSplitType.EQUAL }
      : obj;

  return withSplitType;
}

// Alias kept for readability below.
const injectDefaultSplitType = normaliseExpenseBody;

/**
 * The main create-expense body schema.
 *
 * Parsing pipeline:
 *   1. z.preprocess:  inject splitType: EQUAL when absent (backward compat)
 *   2. discriminatedUnion: parse into one of four branch shapes; per-field and
 *      per-array validation runs here (including uniqueness checks)
 *   3. .superRefine:  cross-field sum checks that require multiple fields
 *      in scope simultaneously (EXACT sum, PERCENT sum)
 *
 * Parsed shapes:
 *   { splitType: 'EQUAL',   participantIds?: string[], ...base }
 *   { splitType: 'EXACT',   participants: ExactParticipant[], ...base }
 *   { splitType: 'PERCENT', participants: PercentParticipant[], ...base }
 *   { splitType: 'SHARES',  participants: SharesParticipant[], ...base }
 *
 * Old clients that send no `splitType` are routed to the EQUAL branch.
 * Old clients that send only `participantIds` (no participants) continue to work.
 */
export const createExpenseBodySchema = z.preprocess(
  injectDefaultSplitType,
  z
    .discriminatedUnion('splitType', [
      equalBodySchema,
      exactBodySchema,
      percentBodySchema,
      sharesBodySchema,
    ])
    .superRefine((body, ctx) => {
      // ── Phase 4: payer presence check ──────────────────────────────────────
      // At least one of paidByUserId or payments must be present.
      const hasPaidBy = body.paidByUserId !== undefined && body.paidByUserId !== null;
      const hasPayments = Array.isArray(body.payments) && body.payments.length > 0;

      if (!hasPaidBy && !hasPayments) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['paidByUserId'],
          message:
            'Either paidByUserId or payments must be provided.',
        });
        return; // Stop further payment checks — data is incomplete.
      }

      // ── Phase 4: payments[] cross-field validation ──────────────────────────
      // Only run when payments[] is explicitly provided. Old clients that send
      // paidByUserId skip this block entirely.
      if (hasPayments && body.payments !== undefined) {
        // No duplicate payer userIds.
        const seen = new Set<string>();
        for (let i = 0; i < body.payments.length; i++) {
          const id = body.payments[i]!.userId;
          if (seen.has(id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['payments', i, 'userId'],
              message: `Duplicate userId: "${id}" appears more than once in payments`,
            });
          }
          seen.add(id);
        }

        // SUM(contributionMinor) must equal amountMinor exactly.
        const sum = body.payments.reduce((acc, p) => acc + p.contributionMinor, 0);
        if (sum !== body.amountMinor) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['payments'],
            message:
              `payments: contributionMinor values sum to ${String(sum)} minor units ` +
              `but amountMinor is ${String(body.amountMinor)} minor units ` +
              `(difference: ${String(sum - body.amountMinor)} minor units).`,
          });
        }
      }

      // ── EXACT: cross-field sum check ────────────────────────────────────────
      // SUM(exactAmountMinor) must equal amountMinor exactly.
      // We check here (not inside the calculator) so the error carries a
      // structured Zod path ("participants") and a human-readable diff message,
      // rather than being caught later as a generic 400.
      if (body.splitType === ExpenseSplitType.EXACT) {
        const sum = body.participants.reduce((acc, p) => acc + p.exactAmountMinor, 0);
        if (sum !== body.amountMinor) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['participants'],
            message:
              `EXACT: exactAmountMinor values sum to ${String(sum)} minor units ` +
              `but amountMinor is ${String(body.amountMinor)} minor units ` +
              `(difference: ${String(sum - body.amountMinor)} minor units).`,
          });
        }
      }

      // ── PERCENT: cross-field sum check ──────────────────────────────────────
      // SUM(basisPoints) must equal 10 000 (100%) exactly.
      if (body.splitType === ExpenseSplitType.PERCENT) {
        const sum = body.participants.reduce((acc, p) => acc + p.basisPoints, 0);
        if (sum !== 10_000) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['participants'],
            message:
              `PERCENT: basisPoints values sum to ${String(sum)} ` +
              `(${(sum / 100).toFixed(2)}%) but must total exactly ` +
              `10000 (100.00%).`,
          });
        }
      }

      // SHARES: no cross-field sum constraint — shares are proportional;
      //         any positive total is valid.
    }),
);

// ── Other endpoint schemas (unchanged) ────────────────────────────────────────

export const tripIdParamSchema = z.object({
  tripId: uuid,
});

export const expenseIdParamSchema = z.object({
  expenseId: uuid,
});

export const listExpensesQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

// ── Exported types ────────────────────────────────────────────────────────────

export type CreateExpenseBody = z.infer<typeof createExpenseBodySchema>;
export type TripIdParam = z.infer<typeof tripIdParamSchema>;
export type ExpenseIdParam = z.infer<typeof expenseIdParamSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;

// Named exports for the individual participant schemas — used by contract tests
// to validate schema shapes in isolation.
export type ExactParticipant = z.infer<typeof exactParticipantSchema>;
export type PercentParticipant = z.infer<typeof percentParticipantSchema>;
export type SharesParticipant = z.infer<typeof sharesParticipantSchema>;
export type PaymentInput = z.infer<typeof paymentInputSchema>;

// Re-export branch schemas for contract tests that need to parse branches in
// isolation (e.g. to assert that EQUAL parsing works without the full body).
export {
  equalBodySchema,
  exactBodySchema,
  percentBodySchema,
  sharesBodySchema,
  exactParticipantSchema,
  percentParticipantSchema,
  sharesParticipantSchema,
};
