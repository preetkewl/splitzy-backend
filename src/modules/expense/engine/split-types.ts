/**
 * Core types for the split-calculator strategy pattern.
 *
 * Design principles:
 *   - All calculators are pure functions: no DB, no I/O, no side effects.
 *   - Identical inputs → identical outputs, always (deterministic).
 *   - SUM(SplitResult.sharePaise) === amountPaise for every valid output.
 *   - The balance engine (balance-engine.ts) is unchanged — it only ever
 *     reads sharePaise. The metadata fields below are audit/display data.
 *
 * Adding a new split type in the future:
 *   1. Add the enum value in an isolated migration (see architecture docs).
 *   2. Add a RawParticipantInput field for the new strategy's per-participant
 *      input (optional, so existing code compiles unchanged).
 *   3. Add a SplitResult metadata field (nullable, audit only).
 *   4. Implement the SplitCalculator interface.
 *   5. Register in SplitCalculatorRegistry.
 *   6. Add Zod validation branch.
 *   7. Add test coverage.
 */

import type { ExpenseSplitType } from '@prisma/client';

// ── Per-participant input ──────────────────────────────────────────────────────

/**
 * Raw per-participant input to a split calculator.
 *
 * Only the field relevant to the current split type is populated. Each
 * calculator validates that its required field is present and in range,
 * throwing a descriptive error if not.
 *
 *   EQUAL:   only userId is needed; all amount fields are absent.
 *   EXACT:   userId + exactAmountPaise (≥ 0 paise, client-specified).
 *   PERCENT: userId + basisPoints (1–10 000; 10 000 bp = 100%).
 *   SHARES:  userId + shareUnits (1–1 000 000 positive integer ratio).
 */
export interface RawParticipantInput {
  readonly userId: string;
  /** EXACT only — the exact paise amount this participant owes. */
  readonly exactAmountPaise?: number;
  /** PERCENT only — this participant's share in basis points. */
  readonly basisPoints?: number;
  /** SHARES only — this participant's ratio unit count. */
  readonly shareUnits?: number;
}

// ── Per-participant output ────────────────────────────────────────────────────

/**
 * The result produced by a split calculator for one participant.
 *
 * sharePaise is the ONLY field the balance engine and accounting layer
 * ever read. The three nullable metadata fields are persisted to
 * expense_participants for audit and display purposes only — they do
 * not affect balance calculations.
 *
 * Invariant guaranteed by every SplitCalculator implementation:
 *   SUM(sharePaise across all SplitResults for one expense) === amountPaise
 *
 * This invariant is additionally asserted by the service layer before
 * any database write (write-time defense) and by the balance engine when
 * reading expenses (read-time defense).
 */
export interface SplitResult {
  readonly userId: string;

  /**
   * ── CANONICAL ACCOUNTING FIELD ──────────────────────────────────────────
   * The final computed integer share this participant owes, in paise.
   * Written once, never modified. Read by the balance engine.
   */
  readonly sharePaise: number;

  /**
   * ── AUDIT METADATA ──────────────────────────────────────────────────────
   * Exactly one of the following is non-null per SplitResult.
   * null for EQUAL (split is reconstructible; storing metadata is noise).
   * null for non-matching split types.
   */

  /** PERCENT: participant's share in basis points (1–10 000). */
  readonly basisPoints: number | null;
  /** SHARES: participant's raw ratio unit count (1–1 000 000). */
  readonly shareUnits: number | null;
  /** EXACT: client-specified exact paise amount. For EXACT, sharePaise === this. */
  readonly exactAmountPaise: number | null;
}

// ── Calculator interface ──────────────────────────────────────────────────────

/**
 * Contract for a split-strategy calculator.
 *
 * Implementations MUST:
 *   1. Be pure and stateless (no DB, no repos, no side effects).
 *   2. Produce SUM(sharePaise) === amountPaise exactly for any valid input.
 *   3. Throw with a descriptive Error if the input violates preconditions.
 *   4. Produce identical output for identical input (determinism required
 *      for historical reproducibility of balance calculations).
 *   5. Use integer-only arithmetic for all paise values.
 *
 * The payerId parameter is accepted by all calculators for symmetry and
 * future extensibility. EXACT / PERCENT / SHARES calculators currently
 * treat it as informational (the service layer enforces payer-membership
 * and payer-in-participants rules). EQUAL uses it to assign the remainder.
 */
export interface SplitCalculator {
  /** The split type this calculator handles. Used by the registry as the key. */
  readonly splitType: ExpenseSplitType;

  /**
   * Compute per-participant shares.
   *
   * @param amountPaise  Total expense amount. Positive integer. Validated
   *                     by the service before this call.
   * @param participants Raw inputs. Non-empty. Each must carry the field
   *                     appropriate for this calculator's split type.
   * @param payerId      userId of the payer. Validated by the service to
   *                     be present in participants before this call.
   * @returns            One SplitResult per participant (same order as input).
   *                     SUM(sharePaise) === amountPaise.
   */
  calculate(
    amountPaise: number,
    participants: readonly RawParticipantInput[],
    payerId: string,
  ): SplitResult[];
}
