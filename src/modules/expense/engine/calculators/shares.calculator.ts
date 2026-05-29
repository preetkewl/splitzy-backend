/**
 * SHARES split calculator — Largest Remainder Method (LRM).
 *
 * ── Input contract ────────────────────────────────────────────────────────────
 * Each participant supplies shareUnits: a positive integer in [1, 1 000 000].
 * The total units and their proportions determine each share:
 *
 *   shareMinor_i = floor(shareUnits_i / totalUnits × amountMinor)
 *   + 0 or 1 extra minor unit via LRM (see PERCENT calculator for LRM explanation).
 *
 * Example: Alice:Bob:Carol = 3:5:7 shares, total = 15, amount = ₹900 (90 000 p).
 *   Alice: floor(3/15 × 90000) = floor(18000) = 18 000 p (no remainder)
 *   Bob:   floor(5/15 × 90000) = floor(30000) = 30 000 p (no remainder)
 *   Carol: floor(7/15 × 90000) = floor(42000) = 42 000 p (no remainder)
 *   SUM = 90 000 ✓
 *
 * Non-divisible example: 1:2 shares, amount = 100 minor units.
 *   Total units = 3.
 *   A: floor(1/3 × 100) = floor(33.33) = 33. Remainder numerator = 1×100 mod 3 = 1.
 *   B: floor(2/3 × 100) = floor(66.66) = 66. Remainder numerator = 2×100 mod 3 = 2.
 *   totalFloor = 99; extraMinor = 1.
 *   LRM: sort by remainder DESC → B(2) > A(1). B receives the extra minor unit.
 *   Result: A = 33, B = 67. SUM = 100 ✓
 *
 * ── Why BigInt is MANDATORY here (not optional) ───────────────────────────────
 * For PERCENT, the denominator is always 10 000 and the max product is:
 *   10 000 × 100 000 000 000 = 10^15 < Number.MAX_SAFE_INTEGER (≈ 9×10^15).
 *   float64 *can* represent this exactly, but we use BigInt anyway.
 *
 * For SHARES, the denominator is totalUnits (up to n × 1 000 000) and the
 * numerator is shareUnits × amountMinor. Worst case:
 *   shareUnits = 1 000 000; amountMinor = 100 000 000 000.
 *   product = 1 000 000 × 100 000 000 000 = 10^17 >> Number.MAX_SAFE_INTEGER.
 *   float64 cannot represent integers > 2^53 exactly. Using float64 here
 *   would produce silently wrong integer division results for large inputs.
 *   BigInt is a correctness requirement, not a style choice.
 *
 * ── Rounding and determinism ─────────────────────────────────────────────────
 * Identical to PercentSplitCalculator — see that file for the full LRM
 * explanation and the determinism guarantee (userId ASC tie-break).
 */

import { ExpenseSplitType } from '@prisma/client';
import type { RawParticipantInput, SplitCalculator, SplitResult } from '../split-types.js';

export class SharesSplitCalculator implements SplitCalculator {
  readonly splitType = ExpenseSplitType.SHARES;

  calculate(
    amountMinor: number,
    participants: readonly RawParticipantInput[],
    _payerId: string,
  ): SplitResult[] {
    if (participants.length === 0) {
      throw new Error('SHARES: participants must not be empty');
    }

    // ── Validate each participant's shareUnits ───────────────────────────────
    let totalUnits = 0;
    for (const p of participants) {
      if (p.shareUnits === undefined) {
        throw new Error(`SHARES: participant ${p.userId} is missing shareUnits`);
      }
      if (
        !Number.isInteger(p.shareUnits) ||
        p.shareUnits < 1 ||
        p.shareUnits > 1_000_000
      ) {
        throw new Error(
          `SHARES: shareUnits for ${p.userId} must be an integer in [1, 1000000] ` +
            `(got ${String(p.shareUnits)})`,
        );
      }
      totalUnits += p.shareUnits;
    }

    // ── Step 1: floor pass — BigInt mandatory (see overflow analysis above) ──
    const bigAmount = BigInt(amountMinor);
    const bigTotal = BigInt(totalUnits);

    const entries = participants.map((p) => {
      const units = BigInt(p.shareUnits as number);
      const product = units * bigAmount;    // can exceed 2^53 — BigInt required
      const floor = product / bigTotal;     // exact BigInt integer division
      const remainder = product % bigTotal; // exact BigInt modulo [0, totalUnits−1]
      return {
        userId: p.userId,
        shareUnits: p.shareUnits as number,
        floor,
        remainder,
      };
    });

    // ── Step 2: distribute surplus minor unit via LRM ─────────────────────────────
    const totalFloor = entries.reduce((acc, e) => acc + e.floor, 0n);
    // extraMinor is in [0, n−1] — proven by the property of integer LRM
    const extraMinor = amountMinor - Number(totalFloor);

    // Sort by fractional remainder DESC; tie-break by userId ASC (deterministic).
    const sortedByRemainder = entries
      .map((e) => ({ userId: e.userId, remainder: e.remainder }))
      .sort((a, b) => {
        if (b.remainder !== a.remainder) {
          return b.remainder > a.remainder ? 1 : -1;
        }
        return a.userId.localeCompare(b.userId);
      });

    const receivesExtra = new Set(
      sortedByRemainder.slice(0, extraMinor).map((e) => e.userId),
    );

    // ── Step 3: assemble results ──────────────────────────────────────────────
    return entries.map((e) => ({
      userId: e.userId,
      shareMinor: Number(e.floor) + (receivesExtra.has(e.userId) ? 1 : 0),
      basisPoints: null,
      shareUnits: e.shareUnits,
      exactAmountMinor: null,
    }));
  }
}
