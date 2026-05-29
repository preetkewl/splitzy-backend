/**
 * BalanceEngine — pure, deterministic, integer-only money math.
 *
 * Owns three primitives:
 *   - splitEqual:           per-expense equal split (with remainder absorbed by payer)
 *   - computeNetBalances:   aggregate per-user net across many expenses
 *   - simplify:             greedy minimum-transfer debt simplification
 *
 * Invariants enforced by tests:
 *   1. SUM(shareMinor) === amountMinor        (no minor unit loss in a split)
 *   2. SUM(netBalance.netMinor) === 0         (no minor unit loss in aggregation)
 *   3. simplify(b)                            produces ≤ |creditors| + |debtors| − 1 transfers
 *   4. simplify(b)                            is deterministic for the same input
 *
 * Note on frontend parity:
 *   The Flutter `balances.dart computeNet` drifts by `amount % n` per
 *   expense (the comment in that file calls this out). Our engine is
 *   stricter — payer absorbs the remainder, sum stays exactly zero.
 *   For amounts evenly divisible by n (e.g. the Goa fixture) the two
 *   algorithms produce identical net balances and identical transfers.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ParticipantShare {
  userId: string;
  shareMinor: number;
}

export interface ExpenseInput {
  /** Whichever user laid out the cash. Must appear in `participants`. */
  payerId: string;
  /** Total amount in minor units; positive integer. */
  amountMinor: number;
  /** Per-participant share. SUM(shareMinor) must equal amountMinor. */
  participants: readonly ParticipantShare[];
}

export interface NetBalance {
  userId: string;
  /** > 0: this user is owed; < 0: this user owes; 0: settled. */
  netMinor: number;
}

export interface SettlementTransfer {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export const BalanceEngine = {
  /**
   * Equal-split shares for one expense. Payer absorbs floor-division
   * remainder so SUM(shares) === amountMinor exactly.
   *
   * Throws if input is malformed (non-positive amount, empty list, payer
   * missing from participants). Defensive — service-layer validation
   * should catch these too, but the engine is the last line of defense
   * for the math invariant.
   */
  splitEqual(
    amountMinor: number,
    participantIds: readonly string[],
    payerId: string,
  ): ParticipantShare[] {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new Error(`splitEqual: amountMinor must be a positive integer (got ${String(amountMinor)})`);
    }
    if (participantIds.length === 0) {
      throw new Error('splitEqual: participantIds must not be empty');
    }
    if (!participantIds.includes(payerId)) {
      throw new Error('splitEqual: payerId must be one of the participants');
    }
    const n = participantIds.length;
    const baseShare = Math.floor(amountMinor / n);
    const payerShare = amountMinor - baseShare * (n - 1);
    return participantIds.map((userId) => ({
      userId,
      shareMinor: userId === payerId ? payerShare : baseShare,
    }));
  },

  /**
   * Per-user net balance:
   *
   *   SUM(paid as payer)
   * − SUM(share owed as participant)
   * + SUM(amount paid in completed settlements)
   * − SUM(amount received in completed settlements)
   *
   * The settlement contribution preserves zero-sum: each settlement
   * row adds +amount to the payer and −amount to the receiver, so
   * SUM(net) stays 0.
   *
   * Returns one row per `memberId` in input order, plus rows for any
   * non-member who appears in the expenses or settlements (e.g. a
   * removed user with residual activity), sorted by `userId` ASC.
   * Order of memberIds drives the downstream simplify() ordering — pass
   * them in a stable order (e.g. tripMembers.joinedAt ASC).
   */
  computeNetBalances(
    memberIds: readonly string[],
    expenses: readonly ExpenseInput[],
    completedSettlements: readonly SettlementTransfer[] = [],
  ): NetBalance[] {
    const net = new Map<string, number>();
    for (const id of memberIds) net.set(id, 0);

    for (const expense of expenses) {
      net.set(expense.payerId, (net.get(expense.payerId) ?? 0) + expense.amountMinor);
      let shareSum = 0;
      for (const p of expense.participants) {
        net.set(p.userId, (net.get(p.userId) ?? 0) - p.shareMinor);
        shareSum += p.shareMinor;
      }
      // Belt-and-braces: every persisted expense was created with shares
      // that sum to amountMinor. If anyone hand-edits the DB and breaks
      // that, we want a loud failure here.
      if (shareSum !== expense.amountMinor) {
        throw new Error(
          `computeNetBalances: participant shares (${String(shareSum)}) do not sum to amount (${String(expense.amountMinor)})`,
        );
      }
    }

    for (const s of completedSettlements) {
      if (!Number.isInteger(s.amountMinor) || s.amountMinor <= 0) {
        throw new Error(
          `computeNetBalances: settlement amountMinor must be a positive integer (got ${String(s.amountMinor)})`,
        );
      }
      if (s.fromUserId === s.toUserId) {
        throw new Error('computeNetBalances: settlement fromUserId must differ from toUserId');
      }
      // Payer's debt shrinks (net moves up); receiver's credit shrinks (net moves down).
      net.set(s.fromUserId, (net.get(s.fromUserId) ?? 0) + s.amountMinor);
      net.set(s.toUserId, (net.get(s.toUserId) ?? 0) - s.amountMinor);
    }

    const seen = new Set(memberIds);
    const result: NetBalance[] = memberIds.map((userId) => ({
      userId,
      netMinor: net.get(userId) ?? 0,
    }));
    const extras = Array.from(net.entries())
      .filter(([id]) => !seen.has(id))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [userId, netMinor] of extras) {
      result.push({ userId, netMinor });
    }
    return result;
  },

  /**
   * Greedy minimum-transfer debt simplification.
   *
   * Sort creditors by net DESC, debtors by |net| DESC; pair the largest
   * of each, settle one of them, advance, repeat. Ties are broken by
   * userId ASC so the same input always produces the same transfer list.
   *
   * Number of transfers is at most max(|creditors|, |debtors|) ≤ n − 1.
   */
  simplify(balances: readonly NetBalance[]): SettlementTransfer[] {
    const creditors = balances
      .filter((b) => b.netMinor > 0)
      .map((b) => ({ userId: b.userId, remaining: b.netMinor }))
      .sort((a, b) => {
        if (b.remaining !== a.remaining) return b.remaining - a.remaining;
        return a.userId.localeCompare(b.userId);
      });
    const debtors = balances
      .filter((b) => b.netMinor < 0)
      .map((b) => ({ userId: b.userId, remaining: -b.netMinor }))
      .sort((a, b) => {
        if (b.remaining !== a.remaining) return b.remaining - a.remaining;
        return a.userId.localeCompare(b.userId);
      });

    const transfers: SettlementTransfer[] = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const d = debtors[i];
      const c = creditors[j];
      if (d === undefined || c === undefined) break;
      const pay = d.remaining < c.remaining ? d.remaining : c.remaining;
      if (pay > 0) {
        transfers.push({
          fromUserId: d.userId,
          toUserId: c.userId,
          amountMinor: pay,
        });
      }
      d.remaining -= pay;
      c.remaining -= pay;
      if (d.remaining === 0) i += 1;
      if (c.remaining === 0) j += 1;
    }
    return transfers;
  },
} as const;
