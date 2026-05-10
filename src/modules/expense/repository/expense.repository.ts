import type {
  Expense,
  ExpenseCategory,
  ExpenseParticipant,
  PrismaClient,
  TripMember,
  User,
} from '@prisma/client';
import { Prisma, ExpenseSplitType } from '@prisma/client';
import { notDeleted } from '../../../database/constants.js';
import type { PaginationParams } from '../../../database/helpers.js';
import type { ParticipantShare } from '../engine/balance-engine.js';

// ── Row shapes ───────────────────────────────────────────────────────────────

export type ExpenseParticipantWithUser = ExpenseParticipant & { user: User };

export interface ExpenseWithRelations extends Expense {
  paidBy: User;
  participants: ExpenseParticipantWithUser[];
}

export interface ExpenseAggregateRow {
  expenseId: string;
  amountPaise: number;
  payerId: string;
  participants: { userId: string; sharePaise: number }[];
}

export interface TripMemberWithUser extends TripMember {
  user: User;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CreateExpenseData {
  tripId: string;
  title: string;
  amountPaise: number;
  category: ExpenseCategory;
  paidById: string;
  createdById: string;
  spentAt: Date;
  shares: readonly ParticipantShare[];
}

// ── Interface + impl ─────────────────────────────────────────────────────────

export interface IExpenseRepository {
  create(data: CreateExpenseData): Promise<ExpenseWithRelations>;
  findById(expenseId: string): Promise<ExpenseWithRelations | null>;
  listByTrip(
    tripId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: ExpenseWithRelations[]; total: number }>;
  /**
   * Lean fetch optimized for the balance engine — only the data needed
   * to compute net balances + total reimbursed. Does NOT include the
   * full User row per participant; the balance service does that
   * separately for member metadata.
   */
  findForBalances(tripId: string): Promise<ExpenseAggregateRow[]>;
  softDelete(expenseId: string): Promise<Expense>;
}

const expenseInclude = {
  paidBy: true,
  participants: {
    include: { user: true },
    orderBy: { createdAt: Prisma.SortOrder.asc },
  },
} satisfies Prisma.ExpenseInclude;

export class ExpenseRepository implements IExpenseRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ── create ───────────────────────────────────────────────────────────────

  async create(data: CreateExpenseData): Promise<ExpenseWithRelations> {
    if (data.shares.length === 0) {
      throw new Error('create: shares must not be empty');
    }
    return this.prisma.expense.create({
      data: {
        tripId: data.tripId,
        title: data.title,
        amountPaise: data.amountPaise,
        category: data.category,
        splitType: ExpenseSplitType.EQUAL,
        paidById: data.paidById,
        createdById: data.createdById,
        spentAt: data.spentAt,
        participants: {
          create: data.shares.map((s) => ({
            userId: s.userId,
            sharePaise: s.sharePaise,
          })),
        },
      },
      include: expenseInclude,
    });
  }

  // ── reads ────────────────────────────────────────────────────────────────

  findById(expenseId: string): Promise<ExpenseWithRelations | null> {
    return this.prisma.expense.findFirst({
      where: { id: expenseId, ...notDeleted },
      include: expenseInclude,
    });
  }

  /**
   * One transaction issuing two queries — paged rows (with deep includes)
   * + total — so the count and the page see the same snapshot.
   */
  async listByTrip(
    tripId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: ExpenseWithRelations[]; total: number }> {
    const where: Prisma.ExpenseWhereInput = {
      tripId,
      ...notDeleted,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.expense.findMany({
        where,
        // (tripId, spentAt DESC) composite index handles ordering.
        orderBy: [{ spentAt: 'desc' }, { createdAt: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
        include: expenseInclude,
      }),
      this.prisma.expense.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Single deep query: trip's expenses + participants (no User join).
   * Used by the balance service which fetches members + users separately.
   */
  async findForBalances(tripId: string): Promise<ExpenseAggregateRow[]> {
    const rows = await this.prisma.expense.findMany({
      where: { tripId, ...notDeleted },
      select: {
        id: true,
        amountPaise: true,
        paidById: true,
        participants: {
          select: { userId: true, sharePaise: true },
          orderBy: { createdAt: Prisma.SortOrder.asc },
        },
      },
      orderBy: { spentAt: 'asc' },
    });
    return rows.map((r) => ({
      expenseId: r.id,
      amountPaise: r.amountPaise,
      payerId: r.paidById,
      participants: r.participants,
    }));
  }

  // ── delete ───────────────────────────────────────────────────────────────

  softDelete(expenseId: string): Promise<Expense> {
    return this.prisma.expense.update({
      where: { id: expenseId },
      data: { deletedAt: new Date() },
    });
  }
}
