/**
 * EQUAL split calculator.
 *
 * Division rule:
 *   baseShare  = floor(amountMinor / n)
 *   payerShare = amountMinor − baseShare × (n − 1)
 *
 * Every non-payer participant receives baseShare. The payer receives
 * payerShare, which absorbs the floor-division remainder so that
 * SUM(shareMinor) = amountMinor exactly.
 *
 * Why payer absorbs the remainder (not the first participant alphabetically):
 *   For equal splits the payer is already the most "invested" party — they
 *   laid out the cash. Giving them the extra minor unit keeps the rule simple,
 *   auditable, and consistent with the historical BalanceEngine.splitEqual()
 *   behaviour that pre-dates this refactor.
 *
 * Delegation rationale:
 *   This calculator delegates to BalanceEngine.splitEqual() rather than
 *   re-implementing the floor-division logic. That function is the canonical,
 *   tested implementation used by all historical expenses. Delegating ensures
 *   the two code paths can never drift apart — there is only one
 *   implementation of equal-split arithmetic in the codebase.
 *
 * Metadata: all three audit fields (basisPoints, shareUnits, exactAmountMinor)
 * are null. EQUAL splits are fully reconstructible from amountMinor and n, so
 * storing metadata would be redundant.
 */

import { ExpenseSplitType } from '@prisma/client';
import { BalanceEngine } from '../balance-engine.js';
import type { RawParticipantInput, SplitCalculator, SplitResult } from '../split-types.js';

export class EqualSplitCalculator implements SplitCalculator {
  readonly splitType = ExpenseSplitType.EQUAL;

  calculate(
    amountMinor: number,
    participants: readonly RawParticipantInput[],
    payerId: string,
  ): SplitResult[] {
    // BalanceEngine.splitEqual performs its own input validation (non-positive
    // amount, empty list, payer not in participants) and will throw before
    // returning if any precondition is violated.
    const shares = BalanceEngine.splitEqual(
      amountMinor,
      participants.map((p) => p.userId),
      payerId,
    );

    return shares.map((s) => ({
      userId: s.userId,
      shareMinor: s.shareMinor,
      basisPoints: null,
      shareUnits: null,
      exactAmountMinor: null,
    }));
  }
}
