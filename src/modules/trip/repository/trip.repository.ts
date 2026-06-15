import type { PrismaClient, Trip, TripMember, User } from '@prisma/client';
import { Prisma, TripMemberRole } from '@prisma/client';
import { notDeleted } from '../../../database/constants.js';
import type { PaginationParams } from '../../../database/helpers.js';

// ── Row shapes ───────────────────────────────────────────────────────────────

export type TripMemberWithUser = TripMember & { user: User };

export interface TripWithMembers extends Trip {
  members: TripMemberWithUser[];
}

/** A list row enriched with expense aggregates computed in a single groupBy. */
export interface TripListRow extends TripWithMembers {
  totalAmountMinor: number;
  latestExpenseAt: Date | null;
}

export interface TripDetailRow extends TripWithMembers {
  totalAmountMinor: number;
  latestExpenseAt: Date | null;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CreateTripData {
  name: string;
  emoji: string;
  coverColor: string;
  description: string | null;
  createdById: string;
  /**
   * UUIDs to add as members. The creator is added separately as OWNER —
   * pass *additional* members here. Duplicates are deduped by the repo.
   */
  memberIds: readonly string[];
}

export interface UpdateTripData {
  name?: string;
  emoji?: string;
  coverColor?: string;
  description?: string | null;
}

// ── Interface + implementation ───────────────────────────────────────────────

/**
 * Optional hooks run INSIDE the trip-create transaction. `beforeCreate` fires
 * before the trip row is inserted, sharing the same `tx` — this is where
 * entitlement/quota enforcement runs so the check and the insert are atomic and
 * race-safe (the service throws from here to abort the transaction).
 */
export interface TripCreateHooks {
  beforeCreate?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export interface ITripRepository {
  /** Trip create + creator-as-OWNER + extra members in one transaction. */
  create(data: CreateTripData, hooks?: TripCreateHooks): Promise<TripDetailRow>;

  /** Soft-deleted trips are excluded. */
  findById(tripId: string): Promise<Trip | null>;

  /** With members + totals in O(constant) queries. */
  findDetail(tripId: string): Promise<TripDetailRow | null>;

  /** Paged list of trips the user is a member of, with totals. */
  listForUser(
    userId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: TripListRow[]; total: number }>;

  update(tripId: string, data: UpdateTripData): Promise<Trip>;

  softDelete(tripId: string): Promise<Trip>;

  // ── Membership ───────────────────────────────────────────────────────────
  findMembership(tripId: string, userId: string): Promise<TripMember | null>;
  addMembers(tripId: string, userIds: readonly string[]): Promise<TripMemberWithUser[]>;
  removeMember(tripId: string, userId: string): Promise<void>;
  countActiveUsers(userIds: readonly string[]): Promise<number>;
}

const memberInclude = {
  members: {
    // Exclude soft-deleted users so they never appear in "Paid by" /
    // "Split with" selectors, default-participant lists, or push-notify
    // targets. Historical expense rows that reference a deleted user are
    // preserved in the DB; the balance engine surfaces them as "extras"
    // (non-current members) so the balance screen remains correct.
    where: { user: { deletedAt: null } },
    include: { user: true },
    orderBy: { joinedAt: Prisma.SortOrder.asc },
  },
} satisfies Prisma.TripInclude;

export class TripRepository implements ITripRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ── create ─────────────────────────────────────────────────────────────────

  async create(data: CreateTripData, hooks?: TripCreateHooks): Promise<TripDetailRow> {
    // Dedupe + drop creator if present in the supplied member list — the
    // creator is always added as OWNER, never twice.
    const extraMembers = Array.from(new Set(data.memberIds)).filter(
      (id) => id !== data.createdById,
    );

    const trip = await this.prisma.$transaction(async (tx) => {
      // Enforcement hook (e.g. free-tier group limit) runs in-transaction,
      // before the insert, so the check + insert are atomic and race-safe.
      await hooks?.beforeCreate?.(tx);

      const created = await tx.trip.create({
        data: {
          name: data.name,
          emoji: data.emoji,
          coverColor: data.coverColor,
          description: data.description,
          createdById: data.createdById,
          members: {
            create: [
              {
                userId: data.createdById,
                role: TripMemberRole.OWNER,
              },
              ...extraMembers.map((userId) => ({
                userId,
                role: TripMemberRole.MEMBER,
              })),
            ],
          },
        },
        include: memberInclude,
      });
      return created;
    });

    return { ...trip, totalAmountMinor: 0, latestExpenseAt: null };
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  findById(tripId: string): Promise<Trip | null> {
    return this.prisma.trip.findFirst({ where: { id: tripId, ...notDeleted } });
  }

  async findDetail(tripId: string): Promise<TripDetailRow | null> {
    const trip = await this.prisma.trip.findFirst({
      where: { id: tripId, ...notDeleted },
      include: memberInclude,
    });
    if (trip === null) return null;
    const aggregate = await this.prisma.expense.aggregate({
      where: { tripId, deletedAt: null },
      _sum: { amountMinor: true },
      _max: { spentAt: true },
    });
    return {
      ...trip,
      totalAmountMinor: aggregate._sum.amountMinor ?? 0,
      latestExpenseAt: aggregate._max.spentAt,
    };
  }

  /**
   * Listing fans out into 3 queries regardless of the trip count:
   *   1. trip.findMany (page of trips with members+users joined)
   *   2. trip.count   (total for pagination meta)
   *   3. expense.groupBy (sums + max(spentAt) per trip)
   * No N+1.
   */
  async listForUser(
    userId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: TripListRow[]; total: number }> {
    const where: Prisma.TripWhereInput = {
      ...notDeleted,
      members: { some: { userId } },
    };

    const [trips, total] = await this.prisma.$transaction([
      this.prisma.trip.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
        include: memberInclude,
      }),
      this.prisma.trip.count({ where }),
    ]);

    if (trips.length === 0) return { rows: [], total };

    const tripIds = trips.map((t) => t.id);
    const aggregates = await this.prisma.expense.groupBy({
      by: ['tripId'],
      where: { tripId: { in: tripIds }, deletedAt: null },
      _sum: { amountMinor: true },
      _max: { spentAt: true },
    });
    const aggByTripId = new Map<string, { sum: number; max: Date | null }>();
    for (const a of aggregates) {
      aggByTripId.set(a.tripId, {
        sum: a._sum.amountMinor ?? 0,
        max: a._max.spentAt,
      });
    }

    const rows: TripListRow[] = trips.map((t) => {
      const agg = aggByTripId.get(t.id);
      return {
        ...t,
        totalAmountMinor: agg?.sum ?? 0,
        latestExpenseAt: agg?.max ?? null,
      };
    });

    return { rows, total };
  }

  // ── mutations ──────────────────────────────────────────────────────────────

  update(tripId: string, data: UpdateTripData): Promise<Trip> {
    return this.prisma.trip.update({ where: { id: tripId }, data });
  }

  softDelete(tripId: string): Promise<Trip> {
    return this.prisma.trip.update({
      where: { id: tripId },
      data: { deletedAt: new Date() },
    });
  }

  // ── membership ─────────────────────────────────────────────────────────────

  findMembership(tripId: string, userId: string): Promise<TripMember | null> {
    return this.prisma.tripMember.findUnique({
      where: { tripId_userId: { tripId, userId } },
    });
  }

  /**
   * Idempotent member add. `createMany skipDuplicates` quietly ignores
   * users already in the trip; the post-insert select returns the rows
   * we just touched (existing or new) for the response payload.
   */
  async addMembers(
    tripId: string,
    userIds: readonly string[],
  ): Promise<TripMemberWithUser[]> {
    const unique = Array.from(new Set(userIds));
    await this.prisma.tripMember.createMany({
      data: unique.map((userId) => ({ tripId, userId, role: TripMemberRole.MEMBER })),
      skipDuplicates: true,
    });
    return this.prisma.tripMember.findMany({
      where: { tripId, userId: { in: unique } },
      include: { user: true },
      orderBy: { joinedAt: 'asc' },
    });
  }

  async removeMember(tripId: string, userId: string): Promise<void> {
    await this.prisma.tripMember.delete({
      where: { tripId_userId: { tripId, userId } },
    });
  }

  /**
   * How many of the supplied UUIDs map to live (non-deleted) users.
   * Used by the service to reject `addMembers` calls that reference
   * users that don't exist or have been soft-deleted.
   */
  async countActiveUsers(userIds: readonly string[]): Promise<number> {
    if (userIds.length === 0) return 0;
    return this.prisma.user.count({
      where: { id: { in: [...userIds] }, deletedAt: null },
    });
  }
}
