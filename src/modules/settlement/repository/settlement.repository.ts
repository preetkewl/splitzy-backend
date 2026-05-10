import type { PrismaClient, SettlementMethod , Prisma} from '@prisma/client';
import { SettlementStatus } from '@prisma/client';
import type { PaginationParams } from '../../../database/helpers.js';
import type { SettlementWithUsers } from '../mapper/settlement.mapper.js';

// ── Lean projection used by the balance engine ───────────────────────────────

export interface SettlementForBalance {
  fromUserId: string;
  toUserId: string;
  amountPaise: number;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CreateSettlementData {
  tripId: string;
  fromUserId: string;
  toUserId: string;
  amountPaise: number;
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
        amountPaise: data.amountPaise,
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
      select: { fromUserId: true, toUserId: true, amountPaise: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      fromUserId: r.fromUserId,
      toUserId: r.toUserId,
      amountPaise: r.amountPaise,
    }));
  }
}
