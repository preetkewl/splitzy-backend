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
 *
 * Phase 3 — multi-contributor model:
 *   ExpenseInput now carries a payments[] array instead of a single payerId.
 *   Each payment entry credits its contributor; each participant entry incurs
 *   a debt. The engine is fully agnostic to the number of contributors.
 *
 *   Computation per user:
 *     net = SUM(contributionMinor in payments)
 *         − SUM(shareMinor in participants)
 *         + SUM(amountMinor in completed settlements sent)
 *         − SUM(amountMinor in completed settlements received)
 *
 *   Validation enforced at read time:
 *     - SUM(payments.contributionMinor) === expense.amountMinor
 *     - at least one payment per expense
 *     - all contributionMinor values are positive integers
 *     - no duplicate contributor userId within one expense
 *     - SUM(participants.shareMinor) === expense.amountMinor
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ParticipantShare {
  userId: string;
  shareMinor: number;
}

/** One contributor's payment towards an expense. */
export interface ExpensePaymentInput {
  userId: string;
  /** Amount this user paid, in minor units. Must be a positive integer. */
  contributionMinor: number;
}

export interface ExpenseInput {
  /** Total amount in minor units; positive integer. */
  amountMinor: number;
  /**
   * Who paid how much. Non-empty, no duplicate userIds.
   * SUM(contributionMinor) must equal amountMinor.
   * All contributionMinor values must be positive integers.
   */
  payments: readonly ExpensePaymentInput[];
  /** Per-participant obligation. SUM(shareMinor) must equal amountMinor. */
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
   * Equal-split obligation shares for one expense. The remainder absorber
   * (payerId) takes the extra minor unit(s) from floor-division so that
   * SUM(shares) === amountMinor exactly.
   *
   * Note: payerId here controls who absorbs the rounding remainder among
   * participants — it is independent of ExpenseInput.payments, which
   * records who actually paid. Conventionally the primary payer absorbs
   * the remainder, but nothing forces this.
   *
   * Throws on malformed input (non-positive amount, empty list, payerId
   * not in participantIds). Service-layer validation should catch these
   * first; the engine is the last line of defence.
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
   * Scalar net for a SINGLE user, from that user's own pre-summed totals.
   *
   * This is the per-user closed form of [computeNetBalances] — because each
   * user's net depends only on their own rows, a user's net is independent of
   * everyone else's. The dashboard endpoint exploits this to compute one number
   * per trip from cheap viewer-filtered aggregates, instead of materialising
   * the full member matrix.
   *
   *   net = paidMinor − shareMinor + settledOutMinor − settledInMinor
   *
   * `dashboard-parity` (smoke test) asserts this equals
   * `computeNetBalances(...)[user].netMinor` for the same data, so the two
   * code paths cannot drift.
   */
  userNet(totals: {
    /** SUM(contributionMinor) over this user's payments. */
    paidMinor: number;
    /** SUM(shareMinor) over this user's participant rows. */
    shareMinor: number;
    /** SUM(amountMinor) over completed settlements this user SENT (fromUser). */
    settledOutMinor: number;
    /** SUM(amountMinor) over completed settlements this user RECEIVED (toUser). */
    settledInMinor: number;
  }): number {
    return totals.paidMinor - totals.shareMinor + totals.settledOutMinor - totals.settledInMinor;
  },

  /**
   * Compute per-user net balance across all expenses and completed settlements.
   *
   * For each expense:
   *   - every payment entry credits its contributor: net[userId] += contributionMinor
   *   - every participant entry debits their obligation: net[userId] -= shareMinor
   *
   * For each completed settlement (fromUserId → toUserId):
   *   - debtor's position improves:  net[fromUserId] += amountMinor
   *   - creditor's position shrinks: net[toUserId]   -= amountMinor
   *
   * SUM(net) === 0 always holds (payments and shares both sum to amountMinor;
   * settlements cancel each other out).
   *
   * Returns one entry per memberId in the supplied order, followed by any
   * extra userIds found in expenses or settlements (e.g. former members),
   * sorted ASC by userId. Pass memberIds in a stable order (e.g. joinedAt ASC)
   * so that simplify() produces deterministic transfer lists.
   */
  computeNetBalances(
    memberIds: readonly string[],
    expenses: readonly ExpenseInput[],
    completedSettlements: readonly SettlementTransfer[] = [],
  ): NetBalance[] {
    const net = new Map<string, number>();
    for (const id of memberIds) net.set(id, 0);

    for (const expense of expenses) {
      // ── Validate and credit the payment (contribution) dimension ──────────
      if (expense.payments.length === 0) {
        throw new Error('computeNetBalances: expense must have at least one payment');
      }
      const contributorsSeen = new Set<string>();
      let contributionSum = 0;
      for (const payment of expense.payments) {
        if (!Number.isInteger(payment.contributionMinor) || payment.contributionMinor <= 0) {
          throw new Error(
            `computeNetBalances: contributionMinor must be a positive integer (got ${String(payment.contributionMinor)})`,
          );
        }
        if (contributorsSeen.has(payment.userId)) {
          throw new Error(
            `computeNetBalances: duplicate contributor '${payment.userId}' in expense`,
          );
        }
        contributorsSeen.add(payment.userId);
        contributionSum += payment.contributionMinor;
        net.set(payment.userId, (net.get(payment.userId) ?? 0) + payment.contributionMinor);
      }
      if (contributionSum !== expense.amountMinor) {
        throw new Error(
          `computeNetBalances: payment contributions (${String(contributionSum)}) do not sum to amount (${String(expense.amountMinor)})`,
        );
      }

      // ── Debit the obligation (participant share) dimension ────────────────
      let shareSum = 0;
      for (const p of expense.participants) {
        net.set(p.userId, (net.get(p.userId) ?? 0) - p.shareMinor);
        shareSum += p.shareMinor;
      }
      // Belt-and-braces: every persisted expense was created with shares that
      // sum to amountMinor. A mismatch here means hand-edited DB data — loud
      // failure is the right response.
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
