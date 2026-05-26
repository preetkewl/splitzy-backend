/**
 * PERCENT split calculator — Largest Remainder Method (LRM).
 *
 * ── Input contract ────────────────────────────────────────────────────────────
 * Each participant supplies basisPoints: an integer in [1, 10 000] where
 * 10 000 bp = 100%. The sum of all basisPoints across the participant list
 * must equal exactly 10 000.
 *
 * ── Rounding algorithm — Largest Remainder Method ────────────────────────────
 * Percentage splits almost always produce non-integer paise values. For
 * example: 33.33% of ₹100 = 33.33 paise, which is not a whole paise.
 * We must distribute amountPaise as an exact integer sum. LRM does this:
 *
 *   Step 1 — Floor pass.
 *     For each participant i, compute the "ideal" share:
 *       ideal_i = basisPoints_i × amountPaise / 10 000
 *     Take the floor:
 *       floor_i = ⌊ideal_i⌋
 *     Compute the fractional remainder (as an integer numerator, not a float):
 *       rem_i = (basisPoints_i × amountPaise) mod 10 000
 *
 *   Step 2 — Distribute surplus.
 *     remainder = amountPaise − Σ(floor_i)
 *     This remainder is always in [0, n−1] when basisPoints sum to 10 000.
 *     Sort participants by rem_i DESC (largest fractional part first).
 *     Tie-break: userId ASC (deterministic, system-independent, history-safe).
 *     Award 1 extra paise to the first `remainder` participants.
 *
 *   Step 3 — Result.
 *     sharePaise_i = floor_i + (1 if participant received extra, else 0)
 *     SUM(sharePaise) = Σ(floor_i) + remainder = amountPaise ✓
 *
 * ── Why LRM is preferred over "payer absorbs remainder" ──────────────────────
 * For EQUAL splits, payer-absorbs is fine because there is only ever 1 paise
 * of remainder and the payer is already the most accountable party.
 * For percentage splits, the remainder can be up to n−1 paise. LRM distributes
 * it more equitably: those with the largest "unpaid" fractional share absorb
 * it first. This also means two participants with identical basisPoints always
 * receive identical sharePaise when possible (tie-break by userId is stable).
 *
 * ── Why BigInt, not float64 ───────────────────────────────────────────────────
 * basisPoints ≤ 10 000; amountPaise ≤ 100 000 000 000 (100 crore paise).
 * Maximum product: 10 000 × 100 000 000 000 = 10^15.
 * Number.MAX_SAFE_INTEGER ≈ 9.007 × 10^15, so the product fits within the
 * safe-integer range — but only barely for large amounts. To eliminate the
 * entire class of floating-point precision bugs (including potential future
 * issues if expense limits are raised), all intermediate arithmetic uses BigInt.
 * BigInt integer division and modulo are exact, making the LRM computation
 * provably correct for any input within the schema constraints.
 *
 * ── Determinism guarantee ────────────────────────────────────────────────────
 * The tie-break of userId ASC ensures that the same set of participants
 * always receives the same extra-paise assignment regardless of the order
 * in which they appear in the input array. Historical balance calculations
 * are reproducible forever as long as the participant set and basisPoints
 * are unchanged — which they will be, because expenses are immutable.
 */

import { ExpenseSplitType } from '@prisma/client';
import type { RawParticipantInput, SplitCalculator, SplitResult } from '../split-types.js';

export class PercentSplitCalculator implements SplitCalculator {
  readonly splitType = ExpenseSplitType.PERCENT;

  private static readonly TOTAL_BASIS_POINTS = 10_000n;

  calculate(
    amountPaise: number,
    participants: readonly RawParticipantInput[],
    _payerId: string,
  ): SplitResult[] {
    if (participants.length === 0) {
      throw new Error('PERCENT: participants must not be empty');
    }

    // ── Validate each participant's basisPoints ──────────────────────────────
    let totalBp = 0;
    for (const p of participants) {
      if (p.basisPoints === undefined) {
        throw new Error(`PERCENT: participant ${p.userId} is missing basisPoints`);
      }
      if (
        !Number.isInteger(p.basisPoints) ||
        p.basisPoints < 1 ||
        p.basisPoints > 10_000
      ) {
        throw new Error(
          `PERCENT: basisPoints for ${p.userId} must be an integer in [1, 10000] ` +
            `(got ${String(p.basisPoints)})`,
        );
      }
      totalBp += p.basisPoints;
    }

    // ── Validate the sum equals exactly 100% ─────────────────────────────────
    if (totalBp !== 10_000) {
      throw new Error(
        `PERCENT: basisPoints must sum to exactly 10000 (100%), ` +
          `got ${String(totalBp)} (${String(totalBp / 100)}%)`,
      );
    }

    // ── Step 1: floor pass using BigInt for exact integer arithmetic ─────────
    const bigAmount = BigInt(amountPaise);
    const denom = PercentSplitCalculator.TOTAL_BASIS_POINTS;

    const entries = participants.map((p) => {
      const bp = BigInt(p.basisPoints as number);
      const product = bp * bigAmount;
      const floor = product / denom;      // exact BigInt integer division
      const remainder = product % denom;  // exact BigInt modulo [0, 9999]
      return {
        userId: p.userId,
        basisPoints: p.basisPoints as number,
        floor,
        remainder,
      };
    });

    // ── Step 2: distribute the surplus paise ─────────────────────────────────
    const totalFloor = entries.reduce((acc, e) => acc + e.floor, 0n);
    // remainder is always in [0, n−1] when basisPoints sum to 10 000
    const extraPaise = amountPaise - Number(totalFloor);

    // Sort by fractional remainder DESC; tie-break by userId ASC.
    // Build a sorted index rather than mutating entries to preserve input order.
    const sortedByRemainder = entries
      .map((e, index) => ({ index, userId: e.userId, remainder: e.remainder }))
      .sort((a, b) => {
        if (b.remainder !== a.remainder) {
          return b.remainder > a.remainder ? 1 : -1;
        }
        return a.userId.localeCompare(b.userId);
      });

    // The first `extraPaise` participants in the sorted order each receive +1.
    const receivesExtra = new Set(
      sortedByRemainder.slice(0, extraPaise).map((e) => e.userId),
    );

    // ── Step 3: assemble results ──────────────────────────────────────────────
    return entries.map((e) => ({
      userId: e.userId,
      sharePaise: Number(e.floor) + (receivesExtra.has(e.userId) ? 1 : 0),
      basisPoints: e.basisPoints,
      shareUnits: null,
      exactAmountPaise: null,
    }));
  }
}
