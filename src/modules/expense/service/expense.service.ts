import { ExpenseCategory, ExpenseSplitType, type User } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { ApiError } from '../../../core/api-error.js';
import { env } from '../../../config/env.js';
import { paginate, type PaginationInput } from '../../../database/helpers.js';
import { logger } from '../../../utils/logger.js';
import type { IUserRepository } from '../../auth/repository/user.repository.js';
import type { NotificationService } from '../../notification/service/notification.service.js';
import type { ISettlementRepository } from '../../settlement/repository/settlement.repository.js';
import type { ITripRepository, TripMemberWithUser } from '../../trip/repository/trip.repository.js';
import { TripAccess } from '../../trip/service/access.js';
import type {
  BalanceSummaryDto,
  CreateExpenseInput,
  ExpenseDto,
} from '../dto/index.js';
import { BalanceEngine, type SettlementTransfer } from '../engine/balance-engine.js';
import type { RawParticipantInput, SplitResult } from '../engine/split-types.js';
import { splitRegistry } from '../engine/split-registry.js';
import {
  toBalanceSummary,
  toExpenseDto,
  toMemberBalances,
} from '../mapper/expense.mapper.js';
import type { IExpenseRepository } from '../repository/expense.repository.js';

export interface ListExpensesResult {
  items: ExpenseDto[];
  page: number;
  pageSize: number;
  total: number;
}

export class ExpenseService {
  private readonly access: TripAccess;

  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly trips: ITripRepository,
    private readonly users: IUserRepository,
    private readonly settlements: ISettlementRepository,
    private readonly notifications: NotificationService,
  ) {
    this.access = new TripAccess(trips);
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(userId: string, input: CreateExpenseInput): Promise<ExpenseDto> {
    const splitType = input.splitType ?? ExpenseSplitType.EQUAL;

    // 1. Feature flag: non-EQUAL split types are gated until the matching
    //    frontend build is in production. Old clients never send splitType,
    //    so they are always routed to EQUAL and are unaffected by this flag.
    if (splitType !== ExpenseSplitType.EQUAL && !env.FEATURE_SPLIT_TYPES_ENABLED) {
      throw ApiError.badRequest(
        `Split type '${splitType}' is not available yet. Use EQUAL or update the app.`,
      );
    }

    // 2. Caller must be a trip member.
    await this.access.assertMember(input.tripId, userId);

    // 3. Pull current trip members once — used for participant defaulting,
    //    payer check, and participant membership validation.
    const trip = await this.trips.findDetail(input.tripId);
    if (trip === null) throw ApiError.notFound('Trip not found');
    const memberIds = new Set(trip.members.map((m) => m.userId));

    // 4. Payer must be a current trip member.
    if (!memberIds.has(input.paidByUserId)) {
      throw ApiError.badRequest('Payer is not a member of this trip');
    }

    // 5. Resolve raw participant inputs based on split type.
    const rawParticipants = this.resolveRawParticipants(input, trip.members);

    if (rawParticipants.length === 0) {
      throw ApiError.badRequest('At least one participant is required');
    }

    // 6. Every participant must be a current trip member.
    for (const p of rawParticipants) {
      if (!memberIds.has(p.userId)) {
        throw ApiError.badRequest(`Participant ${p.userId} is not a member of this trip`);
      }
    }

    // 7. Payer must appear in the participant list for all split types.
    //    For EQUAL: they always owe their share.
    //    For EXACT: their exactAmountMinor may be 0 (they covered everyone).
    //    For PERCENT / SHARES: basisPoints / shareUnits must be ≥ 1 (Zod
    //    already enforced this at the API boundary).
    const payerInParticipants = rawParticipants.some((p) => p.userId === input.paidByUserId);
    if (!payerInParticipants) {
      throw ApiError.badRequest('Payer must be included in the participant list');
    }

    // 8. Dispatch to the appropriate calculator via the registry.
    //    The calculator is a pure function: no DB access, no side effects.
    //    It throws with a descriptive error if inputs violate its preconditions
    //    (e.g. PERCENT basisPoints don't sum to 10 000).
    let splitResults: SplitResult[];
    try {
      splitResults = splitRegistry.compute(splitType, input.amountMinor, rawParticipants, input.paidByUserId);
    } catch (err) {
      // Calculator errors indicate invalid client input (wrong sums, missing
      // fields). Surface them as 400 Bad Request rather than 500.
      const message = err instanceof Error ? err.message : String(err);
      throw ApiError.badRequest(message);
    }

    // 9. Write-time invariant: SUM(shareMinor) must equal amountMinor exactly.
    //    The calculator is responsible for this; this assertion is the last
    //    line of defense before the DB write. A violation here is a bug in
    //    the calculator, not a user error — log it loudly.
    const shareSum = splitResults.reduce((acc, s) => acc + s.shareMinor, 0);
    if (shareSum !== input.amountMinor) {
      logger.error(
        {
          splitType,
          amountMinor: input.amountMinor,
          shareSum,
          diff: shareSum - input.amountMinor,
        },
        'split invariant violated — calculator produced wrong sum',
      );
      throw new Error(
        `Split invariant violated: shares sum to ${String(shareSum)} minor units but ` +
          `expense is ${String(input.amountMinor)} minor units (diff: ${String(shareSum - input.amountMinor)})`,
      );
    }

    // 10. Build the immutable audit snapshot for non-EQUAL splits.
    const splitMeta = this.buildSplitMeta(splitType, rawParticipants);

    // 11. Persist. The nested-create is atomic at the Prisma level.
    //     SplitResult[] maps cleanly to CreateExpenseData.shares.
    //     Phase 2: single payer from the API maps to one ExpensePayment covering
    //     the full amount. Phase 3 will introduce multi-payer input.
    const created = await this.expenses.create({
      tripId: input.tripId,
      title: input.title.trim(),
      amountMinor: input.amountMinor,
      category: input.category ?? ExpenseCategory.MISC,
      splitType,
      payments: [{ userId: input.paidByUserId, contributionMinor: input.amountMinor }],
      createdById: userId,
      spentAt: input.spentAt,
      shares: splitResults,
      splitMeta,
    });

    logger.info(
      {
        expenseId: created.id,
        tripId: input.tripId,
        splitType,
        amountMinor: input.amountMinor,
        participantCount: splitResults.length,
      },
      'expense created',
    );

    // 12. Notify all trip members except the payer (fire-and-forget).
    const notifyUserIds = trip.members
      .map((m) => m.userId)
      .filter((id) => id !== input.paidByUserId);
    if (notifyUserIds.length > 0) {
      const primaryPayerName = created.payments[0]?.user.name ?? 'Someone';
      void this.notifications.sendToUsers(notifyUserIds, {
        title: 'New expense added',
        body: `${primaryPayerName} added "${created.title}"`,
        type: 'EXPENSE_ADDED',
        data: { tripId: input.tripId, expenseId: created.id },
      });
    }

    return toExpenseDto(created, { viewerUserId: userId });
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async list(
    userId: string,
    tripId: string,
    pagination: PaginationInput,
  ): Promise<ListExpensesResult> {
    await this.access.assertMember(tripId, userId);
    const params = paginate(pagination);
    const { rows, total } = await this.expenses.listByTrip(tripId, params);

    return {
      items: rows.map((row) => toExpenseDto(row, { viewerUserId: userId })),
      page: params.page,
      pageSize: params.pageSize,
      total,
    };
  }

  // ── delete ────────────────────────────────────────────────────────────────

  async softDelete(userId: string, expenseId: string): Promise<void> {
    const expense = await this.expenses.findById(expenseId);
    if (expense === null) throw ApiError.notFound('Expense not found');

    await this.access.assertMember(expense.tripId, userId);

    if (expense.createdById !== userId) {
      throw ApiError.forbidden('Only the expense creator can delete an expense');
    }

    await this.expenses.softDelete(expenseId);
    logger.info({ expenseId, tripId: expense.tripId, by: userId }, 'expense soft-deleted');
  }

  // ── balances ──────────────────────────────────────────────────────────────

  async balances(userId: string, tripId: string): Promise<BalanceSummaryDto> {
    await this.access.assertMember(tripId, userId);
    const trip = await this.trips.findDetail(tripId);
    if (trip === null) throw ApiError.notFound('Trip not found');

    const [expenseRows, settlementRows] = await Promise.all([
      this.expenses.findForBalances(tripId),
      this.settlements.findCompletedForBalances(tripId),
    ]);

    // Build per-user totals alongside the engine input. The balance engine
    // is entirely split-type-agnostic: it reads only shareMinor, which is
    // the canonical accounting value regardless of how it was computed.
    const totalsByUser = new Map<string, { paid: number; share: number }>();
    let totalAmountMinor = 0;

    for (const e of expenseRows) {
      totalAmountMinor += e.amountMinor;
      // Payment dimension: credit each payer with their contribution.
      // Phase 2: one payment per expense (contributionMinor === amountMinor).
      for (const payment of e.payments) {
        const payerTotals = totalsByUser.get(payment.userId) ?? { paid: 0, share: 0 };
        payerTotals.paid += payment.contributionMinor;
        totalsByUser.set(payment.userId, payerTotals);
      }
      // Obligation dimension: debit each participant with their share.
      for (const p of e.participants) {
        const t = totalsByUser.get(p.userId) ?? { paid: 0, share: 0 };
        t.share += p.shareMinor;
        totalsByUser.set(p.userId, t);
      }
    }

    const orderedMembers: TripMemberWithUser[] = trip.members;
    const orderedMemberIds = orderedMembers.map((m) => m.userId);
    const currentMemberIds = new Set(orderedMemberIds);

    const completedTransfers: SettlementTransfer[] = settlementRows.map((s) => ({
      fromUserId: s.fromUserId,
      toUserId: s.toUserId,
      amountMinor: s.amountMinor,
    }));
    const totalReimbursedMinor = completedTransfers.reduce(
      (sum, t) => sum + t.amountMinor,
      0,
    );

    // Build BalanceEngine-compatible input from the normalized payment rows.
    // Phase 2 bridge: all data is single-payer, so payments[0] is always the
    // sole payer. Phase 3 will update the balance engine to accept payments[].
    const engineExpenses = expenseRows.map((e) => ({
      payerId: e.payments[0]?.userId ?? '',
      amountMinor: e.amountMinor,
      participants: e.participants,
    }));

    const netBalances = BalanceEngine.computeNetBalances(
      orderedMemberIds,
      engineExpenses,
      completedTransfers,
    );
    const transfers = BalanceEngine.simplify(netBalances);

    const userById = new Map<string, User>();
    for (const m of orderedMembers) userById.set(m.userId, m.user);
    const missing = netBalances.map((b) => b.userId).filter((id) => !userById.has(id));
    for (const id of missing) {
      const u = await this.users.findById(id);
      if (u !== null) userById.set(id, u);
    }

    const memberBalances = toMemberBalances({
      netBalances,
      totalsByUser,
      userById,
      currentMemberIds,
    });

    return toBalanceSummary({
      totalAmountMinor,
      totalReimbursedMinor,
      members: memberBalances,
      transfers,
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Translate the typed CreateExpenseInput into the flat RawParticipantInput
   * list the calculators consume.
   *
   * EQUAL: uses participantIds (or all current members when absent).
   *        Each entry carries only userId — no amount fields.
   *
   * EXACT / PERCENT / SHARES: uses `input.participants` directly.
   *        The Zod schema guarantees the correct per-type field is present.
   */
  private resolveRawParticipants(
    input: CreateExpenseInput,
    members: TripMemberWithUser[],
  ): RawParticipantInput[] {
    if (input.splitType === ExpenseSplitType.EQUAL || input.splitType === undefined) {
      const ids =
        input.participantIds === undefined || input.participantIds.length === 0
          ? members.map((m) => m.userId)
          : Array.from(new Set(input.participantIds));
      return ids.map((userId) => ({ userId }));
    }

    // For EXACT / PERCENT / SHARES the participants array is required and
    // was validated by Zod to contain at least one entry.
    if (input.participants === undefined || input.participants.length === 0) {
      throw ApiError.badRequest(
        `participants is required for split type '${input.splitType}'`,
      );
    }

    // Deduplicate by userId — last entry wins (mirrors equal-split dedup).
    const seen = new Map<string, RawParticipantInput>();
    for (const p of input.participants) {
      seen.set(p.userId, p);
    }
    return Array.from(seen.values());
  }

  /**
   * Build the immutable splitMeta JSON snapshot stored on the Expense row.
   *
   * Returns null for EQUAL — the split is fully reconstructible from
   * amountMinor and participant count, so metadata would be redundant.
   *
   * For other types, stores a { participants: { userId → rawValue } } map
   * where rawValue is the per-participant figure the client originally supplied
   * (exactAmountMinor / basisPoints / shareUnits respectively). The balance
   * engine never reads this field; it is audit/display data only.
   */
  private buildSplitMeta(
    splitType: ExpenseSplitType,
    rawParticipants: readonly RawParticipantInput[],
  ): Prisma.InputJsonValue | null {
    if (splitType === ExpenseSplitType.EQUAL) return null;

    const participants: Record<string, number> = {};

    for (const p of rawParticipants) {
      let value: number;
      if (splitType === ExpenseSplitType.EXACT) {
        value = p.exactAmountMinor ?? 0;
      } else if (splitType === ExpenseSplitType.PERCENT) {
        value = p.basisPoints ?? 0;
      } else {
        // SHARES
        value = p.shareUnits ?? 0;
      }
      participants[p.userId] = value;
    }

    return { type: splitType, participants };
  }
}
