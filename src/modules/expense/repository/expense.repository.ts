import type {
  Expense,
  ExpenseCategory,
  ExpenseSplitType,
  ExpenseParticipant,
  PrismaClient,
  TripMember,
  User,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { notDeleted } from '../../../database/constants.js';
import type { PaginationParams } from '../../../database/helpers.js';
import type { SplitResult } from '../engine/split-types.js';

// ── Row shapes ────────────────────────────────────────────────────────────────

export type ExpenseParticipantWithUser = ExpenseParticipant & { user: User };

export interface ExpenseWithRelations extends Expense {
  paidBy: User;
  participants: ExpenseParticipantWithUser[];
}

export interface ExpenseAggregateRow {
  expenseId: string;
  amountPaise: number;
  payerId: string;
  /** Lean projection: only fields the balance engine needs. */
  participants: { userId: string; sharePaise: number }[];
}

export interface TripMemberWithUser extends TripMember {
  user: User;
}

// ── Input type ────────────────────────────────────────────────────────────────

export interface CreateExpenseData {
  tripId: string;
  title: string;
  amountPaise: number;
  category: ExpenseCategory;
  /**
   * Set by the service from the validated request. No longer hardcoded to
   * EQUAL — the repository is a pure persistence layer and must not know
   * which split type is "default". That decision belongs in the service.
   */
  splitType: ExpenseSplitType;
  paidById: string;
  createdById: string;
  spentAt: Date;
  /**
   * Pre-computed per-participant shares from the SplitCalculator.
   * sharePaise is the canonical accounting value written to the DB.
   * basisPoints / shareUnits / exactAmountPaise are audit metadata.
   * SUM(shares[i].sharePaise) === amountPaise is guaranteed by the
   * service before this method is called.
   */
  shares: readonly SplitResult[];
  /**
   * Immutable JSON snapshot of the raw split intent (null for EQUAL).
   * Written once; never updated. Prisma's InputJsonValue type matches
   * the JSONB column added in migration 20260526100001.
   */
  splitMeta: Prisma.InputJsonValue | null;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IExpenseRepository {
  create(data: CreateExpenseData): Promise<ExpenseWithRelations>;
  findById(expenseId: string): Promise<ExpenseWithRelations | null>;
  listByTrip(
    tripId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: ExpenseWithRelations[]; total: number }>;
  /**
   * Lean fetch for the balance engine. Only sharePaise is selected —
   * the engine never reads basisPoints / shareUnits / exactAmountPaise.
   */
  findForBalances(tripId: string): Promise<ExpenseAggregateRow[]>;
  softDelete(expenseId: string): Promise<Expense>;
}

// ── Prisma include shape ──────────────────────────────────────────────────────

const expenseInclude = {
  paidBy: true,
  participants: {
    include: { user: true },
    orderBy: { createdAt: Prisma.SortOrder.asc },
  },
} satisfies Prisma.ExpenseInclude;

// ── Implementation ────────────────────────────────────────────────────────────

export class ExpenseRepository implements IExpenseRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ── create ────────────────────────────────────────────────────────────────

  async create(data: CreateExpenseData): Promise<ExpenseWithRelations> {
    if (data.shares.length === 0) {
      throw new Error('ExpenseRepository.create: shares must not be empty');
    }

    return this.prisma.expense.create({
      data: {
        tripId: data.tripId,
        title: data.title,
        amountPaise: data.amountPaise,
        category: data.category,
        // Passed through from the service — not hardcoded here.
        splitType: data.splitType,
        // Nullable JSONB audit snapshot. Prisma accepts null for optional
        // JsonValue columns; explicit null is the correct value for EQUAL.
        splitMeta: data.splitMeta ?? Prisma.JsonNull,
        paidById: data.paidById,
        createdById: data.createdById,
        spentAt: data.spentAt,
        participants: {
          create: data.shares.map((s) => ({
            userId: s.userId,
            // Canonical accounting value — always present.
            sharePaise: s.sharePaise,
            // Audit metadata — exactly one is non-null for non-EQUAL splits.
            basisPoints: s.basisPoints,
            shareUnits: s.shareUnits,
            exactAmountPaise: s.exactAmountPaise,
          })),
        },
      },
      include: expenseInclude,
    });
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  findById(expenseId: string): Promise<ExpenseWithRelations | null> {
    return this.prisma.expense.findFirst({
      where: { id: expenseId, ...notDeleted },
      include: expenseInclude,
    });
  }

  /**
   * One transaction issuing two queries — paged rows + total count — so
   * both see the same snapshot. Index (tripId, spentAt DESC) covers the sort.
   */
  async listByTrip(
    tripId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: ExpenseWithRelations[]; total: number }> {
    const where: Prisma.ExpenseWhereInput = { tripId, ...notDeleted };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.expense.findMany({
        where,
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
   * Lean projection for the balance engine — only sharePaise is selected.
   * The balance engine is split-type-agnostic and never reads the audit
   * metadata columns (basisPoints / shareUnits / exactAmountPaise).
   * This query intentionally omits those columns for efficiency.
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

  // ── delete ────────────────────────────────────────────────────────────────

  softDelete(expenseId: string): Promise<Expense> {
    return this.prisma.expense.update({
      where: { id: expenseId },
      data: { deletedAt: new Date() },
    });
  }
}
