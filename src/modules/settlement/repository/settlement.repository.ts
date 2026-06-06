import type { PrismaClient, SettlementMethod , Prisma} from '@prisma/client';
import { SettlementStatus } from '@prisma/client';
import type { PaginationParams } from '../../../database/helpers.js';
import type { SettlementWithUsers } from '../mapper/settlement.mapper.js';

// ── Lean projection used by the balance engine ───────────────────────────────

export interface SettlementForBalance {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CreateSettlementData {
  tripId: string;
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
  method: SettlementMethod;
  note: string | null;
  externalRef: string | null;
  createdById: string;
}

// ── Interface + impl ─────────────────────────────────────────────────────────

export interface ISettlementRepository {
  /**
   * Create a single immutable, COMPLETED settlement row. `settledAt` is
   * stamped server-side at write time. There is no update or soft-delete
   * — once created, a settlement is permanent ledger history.
   */
  create(data: CreateSettlementData): Promise<SettlementWithUsers>;
  findById(id: string): Promise<SettlementWithUsers | null>;
  listByTrip(
    tripId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: SettlementWithUsers[]; total: number }>;
  /**
   * Lean projection — only what the balance engine needs. Filters to
   * status=COMPLETED so PENDING/CANCELLED rows never affect balances.
   */
  findCompletedForBalances(tripId: string): Promise<SettlementForBalance[]>;
  /**
   * Dashboard fan-out collapse: one query for a single viewer's completed
   * settlement totals (sent vs received) across MANY trips. Returns a map
   * keyed by tripId; trips with no viewer settlements are absent.
   */
  findViewerTotalsByTrip(
    tripIds: readonly string[],
    userId: string,
  ): Promise<Map<string, { settledOutMinor: number; settledInMinor: number }>>;
}

const settlementInclude = {
  fromUser: true,
  toUser: true,
} satisfies Prisma.SettlementInclude;

export class SettlementRepository implements ISettlementRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ── create ───────────────────────────────────────────────────────────────

  async create(data: CreateSettlementData): Promise<SettlementWithUsers> {
    return this.prisma.settlement.create({
      data: {
        tripId: data.tripId,
        fromUserId: data.fromUserId,
        toUserId: data.toUserId,
        amountMinor: data.amountMinor,
        method: data.method,
        note: data.note,
        externalRef: data.externalRef,
        createdById: data.createdById,
        status: SettlementStatus.COMPLETED,
        settledAt: new Date(),
      },
      include: settlementInclude,
    });
  }

  // ── reads ────────────────────────────────────────────────────────────────

  findById(id: string): Promise<SettlementWithUsers | null> {
    return this.prisma.settlement.findUnique({
      where: { id },
      include: settlementInclude,
    });
  }

  /**
   * One transaction for findMany + count. Index path:
   * `settlements(tripId, status)` (Step 1) covers the WHERE clause.
   */
  async listByTrip(
    tripId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: SettlementWithUsers[]; total: number }> {
    const where: Prisma.SettlementWhereInput = { tripId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.settlement.findMany({
        where,
        orderBy: [{ settledAt: 'desc' }, { createdAt: 'desc' }],
        skip: pagination.skip,
        take: pagination.take,
        include: settlementInclude,
      }),
      this.prisma.settlement.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Used by the balance service to subtract completed settlements from
   * each user's net. PENDING and CANCELLED are intentionally excluded —
   * unlike expenses, status truly matters here.
   */
  async findCompletedForBalances(tripId: string): Promise<SettlementForBalance[]> {
    const rows = await this.prisma.settlement.findMany({
      where: { tripId, status: SettlementStatus.COMPLETED },
      select: { fromUserId: true, toUserId: true, amountMinor: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      fromUserId: r.fromUserId,
      toUserId: r.toUserId,
      amountMinor: r.amountMinor,
    }));
  }

  async findViewerTotalsByTrip(
    tripIds: readonly string[],
    userId: string,
  ): Promise<Map<string, { settledOutMinor: number; settledInMinor: number }>> {
    const totals = new Map<string, { settledOutMinor: number; settledInMinor: number }>();
    if (tripIds.length === 0) return totals;

    const rows = await this.prisma.settlement.findMany({
      where: {
        tripId: { in: [...tripIds] },
        status: SettlementStatus.COMPLETED,
        OR: [{ fromUserId: userId }, { toUserId: userId }],
      },
      select: { tripId: true, fromUserId: true, toUserId: true, amountMinor: true },
    });

    for (const r of rows) {
      const acc = totals.get(r.tripId) ?? { settledOutMinor: 0, settledInMinor: 0 };
      // A settlement the viewer SENT improves their net (paid down a debt);
      // one they RECEIVED reduces it. Mirrors BalanceEngine settlement signs.
      if (r.fromUserId === userId) acc.settledOutMinor += r.amountMinor;
      if (r.toUserId === userId) acc.settledInMinor += r.amountMinor;
      totals.set(r.tripId, acc);
    }
    return totals;
  }
}
