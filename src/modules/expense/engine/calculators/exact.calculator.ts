/**
 * EXACT split calculator.
 *
 * The client specifies each participant's exact share in paise. No rounding
 * or remainder distribution is applied — sharePaise is set verbatim from
 * exactAmountPaise. The only arithmetic constraint is:
 *
 *   SUM(exactAmountPaise) must equal amountPaise exactly.
 *
 * This makes EXACT the simplest calculator: it validates inputs and copies
 * values through. The invariant check at the end produces a descriptive
 * error so the service can reject the request before any DB write.
 *
 * Edge case — payer with exactAmountPaise = 0:
 *   Valid. A user may pay for everyone and owe nothing themselves. Their
 *   sharePaise = 0; the balance engine credits them +amountPaise (paid) and
 *   debits them −0 (share), giving a net of +amountPaise. Correct.
 *
 * Metadata:
 *   exactAmountPaise is populated for every participant.
 *   basisPoints and shareUnits are null.
 */

import { ExpenseSplitType } from '@prisma/client';
import type { RawParticipantInput, SplitCalculator, SplitResult } from '../split-types.js';

export class ExactSplitCalculator implements SplitCalculator {
  readonly splitType = ExpenseSplitType.EXACT;

  calculate(
    amountPaise: number,
    participants: readonly RawParticipantInput[],
    _payerId: string,
  ): SplitResult[] {
    if (participants.length === 0) {
      throw new Error('EXACT: participants must not be empty');
    }

    let runningSum = 0;
    const results: SplitResult[] = [];

    for (const p of participants) {
      if (p.exactAmountPaise === undefined) {
        throw new Error(
          `EXACT: participant ${p.userId} is missing exactAmountPaise`,
        );
      }
      if (!Number.isInteger(p.exactAmountPaise) || p.exactAmountPaise < 0) {
        throw new Error(
          `EXACT: exactAmountPaise for ${p.userId} must be a non-negative integer ` +
            `(got ${String(p.exactAmountPaise)})`,
        );
      }

      runningSum += p.exactAmountPaise;
      results.push({
        userId: p.userId,
        sharePaise: p.exactAmountPaise,
        basisPoints: null,
        shareUnits: null,
        exactAmountPaise: p.exactAmountPaise,
      });
    }

    // Final invariant check. Must be exact — no rounding is permitted for
    // EXACT splits since the client supplied the amounts themselves.
    if (runningSum !== amountPaise) {
      throw new Error(
        `EXACT: sum of exactAmountPaise (${String(runningSum)} paise) ` +
          `must equal amountPaise (${String(amountPaise)} paise). ` +
          `Difference: ${String(runningSum - amountPaise)} paise.`,
      );
    }

    return results;
  }
}
