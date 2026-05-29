/**
 * EXACT split calculator.
 *
 * The client specifies each participant's exact share in minor units. No rounding
 * or remainder distribution is applied — shareMinor is set verbatim from
 * exactAmountMinor. The only arithmetic constraint is:
 *
 *   SUM(exactAmountMinor) must equal amountMinor exactly.
 *
 * This makes EXACT the simplest calculator: it validates inputs and copies
 * values through. The invariant check at the end produces a descriptive
 * error so the service can reject the request before any DB write.
 *
 * Edge case — payer with exactAmountMinor = 0:
 *   Valid. A user may pay for everyone and owe nothing themselves. Their
 *   shareMinor = 0; the balance engine credits them +amountMinor (paid) and
 *   debits them −0 (share), giving a net of +amountMinor. Correct.
 *
 * Metadata:
 *   exactAmountMinor is populated for every participant.
 *   basisPoints and shareUnits are null.
 */

import { ExpenseSplitType } from '@prisma/client';
import type { RawParticipantInput, SplitCalculator, SplitResult } from '../split-types.js';

export class ExactSplitCalculator implements SplitCalculator {
  readonly splitType = ExpenseSplitType.EXACT;

  calculate(
    amountMinor: number,
    participants: readonly RawParticipantInput[],
    _payerId: string,
  ): SplitResult[] {
    if (participants.length === 0) {
      throw new Error('EXACT: participants must not be empty');
    }

    let runningSum = 0;
    const results: SplitResult[] = [];

    for (const p of participants) {
      if (p.exactAmountMinor === undefined) {
        throw new Error(
          `EXACT: participant ${p.userId} is missing exactAmountMinor`,
        );
      }
      if (!Number.isInteger(p.exactAmountMinor) || p.exactAmountMinor < 0) {
        throw new Error(
          `EXACT: exactAmountMinor for ${p.userId} must be a non-negative integer ` +
            `(got ${String(p.exactAmountMinor)})`,
        );
      }

      runningSum += p.exactAmountMinor;
      results.push({
        userId: p.userId,
        shareMinor: p.exactAmountMinor,
        basisPoints: null,
        shareUnits: null,
        exactAmountMinor: p.exactAmountMinor,
      });
    }

    // Final invariant check. Must be exact — no rounding is permitted for
    // EXACT splits since the client supplied the amounts themselves.
    if (runningSum !== amountMinor) {
      throw new Error(
        `EXACT: sum of exactAmountMinor (${String(runningSum)} minor units) ` +
          `must equal amountMinor (${String(amountMinor)} minor units). ` +
          `Difference: ${String(runningSum - amountMinor)} minor units.`,
      );
    }

    return results;
  }
}
