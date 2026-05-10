import { ExpenseCategory, type User } from '@prisma/client';
import { ApiError } from '../../../core/api-error.js';
import { paginate, type PaginationInput } from '../../../database/helpers.js';
import { logger } from '../../../utils/logger.js';
import type { IUserRepository } from '../../auth/repository/user.repository.js';
import type { ISettlementRepository } from '../../settlement/repository/settlement.repository.js';
import type { ITripRepository, TripMemberWithUser } from '../../trip/repository/trip.repository.js';
import { TripAccess } from '../../trip/service/access.js';
import type {
  BalanceSummaryDto,
  CreateExpenseInput,
  ExpenseDto,
} from '../dto/index.js';
import { BalanceEngine, type SettlementTransfer } from '../engine/balance-engine.js';
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
  ) {
    this.access = new TripAccess(trips);
  }

  // ── create ────────────────────────────────────────────────────────────────

  async create(userId: string, input: CreateExpenseInput): Promise<ExpenseDto> {
    // 1. Caller must be a trip member.
    await this.access.assertMember(input.tripId, userId);

    // 2. Pull current trip members once — used for default participants
    //    + payer membership check + participant membership check.
    const trip = await this.trips.findDetail(input.tripId);
    if (trip === null) throw ApiError.notFound('Trip not found');
    const memberIds = new Set(trip.members.map((m) => m.userId));

    // 3. Payer must be a trip member.
    if (!memberIds.has(input.paidByUserId)) {
      throw ApiError.badRequest('Payer is not a member of this trip');
    }

    // 4. Resolve participants — default = all current members.
    const participantIds =
      input.participantIds === undefined || input.participantIds.length === 0
        ? trip.members.map((m) => m.userId)
        : Array.from(new Set(input.participantIds));

    if (participantIds.length === 0) {
      throw ApiError.badRequest('At least one participant is required');
    }

    // 5. All participants must be current trip members.
    for (const id of participantIds) {
      if (!memberIds.has(id)) {
        throw ApiError.badRequest(`Participant ${id} is not a member of this trip`);
      }
    }

    // 6. Payer must be in the participant list (equal-split semantics).
    if (!participantIds.includes(input.paidByUserId)) {
      throw ApiError.badRequest('Payer must be one of the participants');
    }

    // 7. Compute the equal split. Engine guarantees SUM(shares) == amount.
    const shares = BalanceEngine.splitEqual(
      input.amountPaise,
      participantIds,
      input.paidByUserId,
    );

    // 8. Persist. Prisma's nested-create wraps the insert + participants in
    //    one statement; we don't need an explicit $transaction here because
    //    the engine has already validated the math invariant.
    const created = await this.expenses.create({
      tripId: input.tripId,
      title: input.title.trim(),
      amountPaise: input.amountPaise,
      category: input.category ?? ExpenseCategory.MISC,
      paidById: input.paidByUserId,
      createdById: userId,
      spentAt: input.spentAt,
      shares,
    });

    logger.info(
      { expenseId: created.id, tripId: input.tripId, amountPaise: input.amountPaise },
      'expense created',
    );
    return toExpenseDto(created, {
      viewerUserId: userId,
      tripOwnerId: trip.createdById,
    });
  }

  // ── list ──────────────────────────────────────────────────────────────────

  async list(
    userId: string,
    tripId: string,
    pagination: PaginationInput,
  ): Promise<ListExpensesResult> {
    await this.access.assertMember(tripId, userId);
    const trip = await this.trips.findById(tripId);
    if (trip === null) throw ApiError.notFound('Trip not found');

    const params = paginate(pagination);
    const { rows, total } = await this.expenses.listByTrip(tripId, params);

    return {
      items: rows.map((row) =>
        toExpenseDto(row, { viewerUserId: userId, tripOwnerId: trip.createdById }),
      ),
      page: params.page,
      pageSize: params.pageSize,
      total,
    };
  }

  // ── delete ────────────────────────────────────────────────────────────────

  async softDelete(userId: string, expenseId: string): Promise<void> {
    const expense = await this.expenses.findById(expenseId);
    if (expense === null) throw ApiError.notFound('Expense not found');

    // Caller must be a trip member — covers the case where the expense
    // exists but for a trip the caller can't see (404, not 403).
    await this.access.assertMember(expense.tripId, userId);

    // Permission: payer or trip owner.
    const trip = await this.trips.findById(expense.tripId);
    if (trip === null) throw ApiError.notFound('Trip not found');
    const isPayer = expense.paidById === userId;
    const isOwner = trip.createdById === userId;
    if (!isPayer && !isOwner) {
      throw ApiError.forbidden('Only the payer or the trip owner can delete an expense');
    }

    await this.expenses.softDelete(expenseId);
    logger.info({ expenseId, tripId: expense.tripId, by: userId }, 'expense soft-deleted');
  }

  // ── balances ──────────────────────────────────────────────────────────────

  async balances(userId: string, tripId: string): Promise<BalanceSummaryDto> {
    await this.access.assertMember(tripId, userId);
    const trip = await this.trips.findDetail(tripId);
    if (trip === null) throw ApiError.notFound('Trip not found');

    // 1. Pull aggregated expense + completed-settlement data in parallel.
    //    Both are lean projections (no User joins) — those happen in step 5
    //    only for the userIds the engine surfaces.
    const [expenseRows, settlementRows] = await Promise.all([
      this.expenses.findForBalances(tripId),
      this.settlements.findCompletedForBalances(tripId),
    ]);

    // 2. Build per-user totals (paid + share) alongside the engine input.
    const totalsByUser = new Map<string, { paid: number; share: number }>();
    let totalAmountPaise = 0;
    for (const e of expenseRows) {
      totalAmountPaise += e.amountPaise;
      const payerTotals = totalsByUser.get(e.payerId) ?? { paid: 0, share: 0 };
      payerTotals.paid += e.amountPaise;
      totalsByUser.set(e.payerId, payerTotals);
      for (const p of e.participants) {
        const t = totalsByUser.get(p.userId) ?? { paid: 0, share: 0 };
        t.share += p.sharePaise;
        totalsByUser.set(p.userId, t);
      }
    }

    // 3. Stable member order: by joinedAt ASC (already the trip mapper order).
    const orderedMembers: TripMemberWithUser[] = trip.members;
    const orderedMemberIds = orderedMembers.map((m) => m.userId);
    const currentMemberIds = new Set(orderedMemberIds);

    // 4. Run the engine. Settlements pass through with the same shape the
    //    engine emits from `simplify` — the engine treats them as the
    //    inverse of a suggested transfer (each one cancels itself out
    //    of the net balances).
    const completedTransfers: SettlementTransfer[] = settlementRows.map((s) => ({
      fromUserId: s.fromUserId,
      toUserId: s.toUserId,
      amountPaise: s.amountPaise,
    }));
    const totalReimbursedPaise = completedTransfers.reduce(
      (sum, t) => sum + t.amountPaise,
      0,
    );
    const netBalances = BalanceEngine.computeNetBalances(
      orderedMemberIds,
      expenseRows,
      completedTransfers,
    );
    const transfers = BalanceEngine.simplify(netBalances);

    // 5. Resolve user metadata. Members come from the trip detail; any
    //    "extra" users (former members with residual balance) are fetched
    //    in one batch from the User repo.
    const userById = new Map<string, User>();
    for (const m of orderedMembers) userById.set(m.userId, m.user);
    const missing = netBalances
      .map((b) => b.userId)
      .filter((id) => !userById.has(id));
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
      totalAmountPaise,
      totalReimbursedPaise,
      members: memberBalances,
      transfers,
    });
  }
}
