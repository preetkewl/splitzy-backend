import type {
  Expense,
  ExpenseCategory,
  ExpenseSplitType,
  ExpenseParticipant,
  ExpensePayment,
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
export type ExpensePaymentWithUser = ExpensePayment & { user: User };

export interface ExpenseWithRelations extends Expense {
  payments: ExpensePaymentWithUser[];
  participants: ExpenseParticipantWithUser[];
}

export interface ExpenseAggregateRow {
  expenseId: string;
  amountMinor: number;
  /** All payers for this expense — one entry in Phase 2 (single payer). */
  payments: { userId: string; contributionMinor: number }[];
  /** Lean projection: only fields the balance engine needs. */
  participants: { userId: string; shareMinor: number }[];
}

export interface TripMemberWithUser extends TripMember {
  user: User;
}

// ── Input type ────────────────────────────────────────────────────────────────

export interface CreateExpenseData {
  tripId: string;
  title: string;
  amountMinor: number;
  category: ExpenseCategory;
  /**
   * Set by the service from the validated request. No longer hardcoded to
   * EQUAL — the repository is a pure persistence layer and must not know
   * which split type is "default". That decision belongs in the service.
   */
  splitType: ExpenseSplitType;
  /**
   * Payment dimension: who paid how much.
   * Phase 2: always one entry (contributionMinor === amountMinor).
   * Phase 3: may contain multiple entries; SUM(contributionMinor) === amountMinor
   * is guaranteed by the service before this method is called.
   */
  payments: readonly { userId: string; contributionMinor: number }[];
  createdById: string;
  spentAt: Date;
  /**
   * Pre-computed per-participant shares from the SplitCalculator.
   * shareMinor is the canonical accounting value written to the DB.
   * basisPoints / shareUnits / exactAmountMinor are audit metadata.
   * SUM(shares[i].shareMinor) === amountMinor is guaranteed by the
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
   * Lean fetch for the balance engine. Only shareMinor and contributionMinor
   * are selected — the engine never reads basisPoints / shareUnits / exactAmountMinor.
   */
  findForBalances(tripId: string): Promise<ExpenseAggregateRow[]>;
  /**
   * Dashboard fan-out collapse: one query for a single viewer's paid/share
   * totals across MANY trips. Selects only the viewer's own payment and
   * participant rows (nested `where: { userId }`). Returns a map keyed by
   * tripId; trips with no viewer activity are absent (treat as zeroes).
   */
  findViewerTotalsByTrip(
    tripIds: readonly string[],
    userId: string,
  ): Promise<Map<string, { paidMinor: number; shareMinor: number }>>;
  softDelete(expenseId: string): Promise<Expense>;
}

// ── Prisma include shape ──────────────────────────────────────────────────────

const expenseInclude = {
  payments: {
    include: { user: true },
    orderBy: { createdAt: Prisma.SortOrder.asc },
  },
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
    if (data.payments.length === 0) {
      throw new Error('ExpenseRepository.create: payments must not be empty');
    }

    return this.prisma.expense.create({
      data: {
        tripId: data.tripId,
        title: data.title,
        amountMinor: data.amountMinor,
        category: data.category,
        // Passed through from the service — not hardcoded here.
        splitType: data.splitType,
        // Nullable JSONB audit snapshot. Prisma accepts null for optional
        // JsonValue columns; explicit null is the correct value for EQUAL.
        splitMeta: data.splitMeta ?? Prisma.JsonNull,
        createdById: data.createdById,
        spentAt: data.spentAt,
        payments: {
          create: data.payments.map((p) => ({
            userId: p.userId,
            contributionMinor: p.contributionMinor,
          })),
        },
        participants: {
          create: data.shares.map((s) => ({
            userId: s.userId,
            // Canonical accounting value — always present.
            shareMinor: s.shareMinor,
            // Audit metadata — exactly one is non-null for non-EQUAL splits.
            basisPoints: s.basisPoints,
            shareUnits: s.shareUnits,
            exactAmountMinor: s.exactAmountMinor,
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
   * Lean projection for the balance engine — only shareMinor and
   * contributionMinor are selected.
   * The balance engine is split-type-agnostic and never reads the audit
   * metadata columns (basisPoints / shareUnits / exactAmountMinor).
   * This query intentionally omits those columns for efficiency.
   */
  async findForBalances(tripId: string): Promise<ExpenseAggregateRow[]> {
    const rows = await this.prisma.expense.findMany({
      where: { tripId, ...notDeleted },
      select: {
        id: true,
        amountMinor: true,
        payments: {
          select: { userId: true, contributionMinor: true },
          orderBy: { createdAt: Prisma.SortOrder.asc },
        },
        participants: {
          select: { userId: true, shareMinor: true },
          orderBy: { createdAt: Prisma.SortOrder.asc },
        },
      },
      orderBy: { spentAt: 'asc' },
    });
    return rows.map((r) => ({
      expenseId: r.id,
      amountMinor: r.amountMinor,
      payments: r.payments,
      participants: r.participants,
    }));
  }

  async findViewerTotalsByTrip(
    tripIds: readonly string[],
    userId: string,
  ): Promise<Map<string, { paidMinor: number; shareMinor: number }>> {
    const totals = new Map<string, { paidMinor: number; shareMinor: number }>();
    if (tripIds.length === 0) return totals;

    // One query for all trips. Nested `where: { userId }` narrows each
    // expense's payments/participants to just the viewer's rows, so most
    // expenses carry 0–1 nested rows. deletedAt:null mirrors findForBalances.
    const rows = await this.prisma.expense.findMany({
      where: { tripId: { in: [...tripIds] }, ...notDeleted },
      select: {
        tripId: true,
        payments: { where: { userId }, select: { contributionMinor: true } },
        participants: { where: { userId }, select: { shareMinor: true } },
      },
    });

    for (const r of rows) {
      const acc = totals.get(r.tripId) ?? { paidMinor: 0, shareMinor: 0 };
      for (const p of r.payments) acc.paidMinor += p.contributionMinor;
      for (const p of r.participants) acc.shareMinor += p.shareMinor;
      totals.set(r.tripId, acc);
    }
    return totals;
  }

  // ── delete ────────────────────────────────────────────────────────────────

  softDelete(expenseId: string): Promise<Expense> {
    return this.prisma.expense.update({
      where: { id: expenseId },
      data: { deletedAt: new Date() },
    });
  }
}
