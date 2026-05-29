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

    // 4. Resolve effective payments from either the canonical payments[] field
    //    (Phase 4 clients) or the legacy paidByUserId field (old clients).
    //    Validation above guarantees at least one is present.
    const effectivePayments = this.resolveEffectivePayments(input);

    // 5. Every payer must be a current trip member.
    for (const payment of effectivePayments) {
      if (!memberIds.has(payment.userId)) {
        throw ApiError.badRequest(`Payer ${payment.userId} is not a member of this trip`);
      }
    }

    // 6. Resolve raw participant inputs based on split type.
    const rawParticipants = this.resolveRawParticipants(input, trip.members);

    if (rawParticipants.length === 0) {
      throw ApiError.badRequest('At least one participant is required');
    }

    // 7. Every participant must be a current trip member.
    for (const p of rawParticipants) {
      if (!memberIds.has(p.userId)) {
        throw ApiError.badRequest(`Participant ${p.userId} is not a member of this trip`);
      }
    }

    // 8. Every payer must appear in the participant list.
    //    For EQUAL: they always owe their share.
    //    For EXACT: their exactAmountMinor may be 0 (they covered everyone).
    //    For PERCENT / SHARES: basisPoints / shareUnits must be ≥ 1.
    const participantUserIds = new Set(rawParticipants.map((p) => p.userId));
    for (const payment of effectivePayments) {
      if (!participantUserIds.has(payment.userId)) {
        throw ApiError.badRequest(
          `Payer ${payment.userId} must be included in the participant list`,
        );
      }
    }

    // 9. Dispatch to the appropriate calculator via the registry.
    //    The calculator is a pure function: no DB access, no side effects.
    //    It throws with a descriptive error if inputs violate its preconditions
    //    (e.g. PERCENT basisPoints don't sum to 10 000).
    //    Pass the primary payer ID (first payment user) for calculators that
    //    use it for rounding remainder assignment.
    const primaryPayerUserId = effectivePayments[0]!.userId;
    let splitResults: SplitResult[];
    try {
      splitResults = splitRegistry.compute(splitType, input.amountMinor, rawParticipants, primaryPayerUserId);
    } catch (err) {
      // Calculator errors indicate invalid client input (wrong sums, missing
      // fields). Surface them as 400 Bad Request rather than 500.
      const message = err instanceof Error ? err.message : String(err);
      throw ApiError.badRequest(message);
    }

    // 10. Write-time invariant: SUM(shareMinor) must equal amountMinor exactly.
    //     The calculator is responsible for this; this assertion is the last
    //     line of defense before the DB write. A violation here is a bug in
    //     the calculator, not a user error — log it loudly.
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

    // 11. Build the immutable audit snapshot for non-EQUAL splits.
    const splitMeta = this.buildSplitMeta(splitType, rawParticipants);

    // 12. Persist. The nested-create is atomic at the Prisma level.
    //     effectivePayments carries the canonical payment list (one or many payers).
    //     SplitResult[] maps cleanly to CreateExpenseData.shares.
    const created = await this.expenses.create({
      tripId: input.tripId,
      title: input.title.trim(),
      amountMinor: input.amountMinor,
      category: input.category ?? ExpenseCategory.MISC,
      splitType,
      payments: effectivePayments,
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
        payerCount: effectivePayments.length,
      },
      'expense created',
    );

    // 13. Notify all trip members except all payers (fire-and-forget).
    const payerUserIds = new Set(effectivePayments.map((p) => p.userId));
    const notifyUserIds = trip.members
      .map((m) => m.userId)
      .filter((id) => !payerUserIds.has(id));
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

    // Fetch sequentially so that any settlement created concurrently is either
    // fully included in both reads or fully absent from both. Running these in
    // parallel (Promise.all) creates a read-skew window: the settlements query
    // could observe a new row that was committed AFTER the expenses query,
    // making the net-balance temporarily inconsistent. Sequential ordering is
    // the cheapest isolation guarantee without a full REPEATABLE READ transaction.
    const expenseRows = await this.expenses.findForBalances(tripId);
    const settlementRows = await this.settlements.findCompletedForBalances(tripId);

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

    const engineExpenses = expenseRows.map((e) => ({
      amountMinor: e.amountMinor,
      payments: e.payments,
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
    // Former members (left the trip) appear in netBalances but not in orderedMembers.
    // Batch-fetch them in one query instead of looping N individual findById calls.
    const missingIds = netBalances.map((b) => b.userId).filter((id) => !userById.has(id));
    if (missingIds.length > 0) {
      const fetchedUsers = await this.users.findManyByIds(missingIds);
      for (const u of fetchedUsers) userById.set(u.id, u);
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
   * Resolve the canonical payments list from the request input.
   *
   * Phase 4 clients send payments[] directly.
   * Legacy clients send paidByUserId; we derive a single payment covering
   * the full amountMinor.
   *
   * The Zod validation layer guarantees at least one of the two is present,
   * so no fallback error is needed here.
   */
  private resolveEffectivePayments(
    input: CreateExpenseInput,
  ): { userId: string; contributionMinor: number }[] {
    if (input.payments !== undefined && input.payments.length > 0) {
      return input.payments.map((p) => ({
        userId: p.userId,
        contributionMinor: p.contributionMinor,
      }));
    }
    // Legacy path: paidByUserId guaranteed present by Zod validation.
    return [{ userId: input.paidByUserId!, contributionMinor: input.amountMinor }];
  }

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
