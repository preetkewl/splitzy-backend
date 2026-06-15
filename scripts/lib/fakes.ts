/**
 * Shared in-memory repository fakes for smoke tests.
 *
 * Implements all repository interfaces against a single `FakeStore` so
 * tests across multiple modules (auth, trip, …) see a consistent state.
 * Behaviour mirrors Prisma where it matters for assertions:
 *   - soft-delete filters
 *   - unique-violation rejections (createMany skipDuplicates, etc.)
 *   - cascading deletes for trip → members
 */
import { randomUUID } from 'node:crypto';
import type {
  Activity,
  DeviceToken,
  Expense,
  ExpenseParticipant,
  ExpensePayment,
  FriendRequest,
  Friendship,
  Platform,
  RefreshToken,
  Settlement,
  Trip,
  TripMember,
  TripMemberRole,
  User,
} from '@prisma/client';
import { FriendRequestStatus, SettlementStatus } from '@prisma/client';
import { canonicalFriendshipPair } from '../../src/database/helpers.js';
import type {
  CreateRefreshTokenInput,
  IRefreshTokenRepository,
} from '../../src/modules/auth/repository/refresh-token.repository.js';
import type {
  CreateUserInput,
  IUserRepository,
  UpdateUserInput,
} from '../../src/modules/auth/repository/user.repository.js';
import type {
  CreateExpenseData,
  ExpenseAggregateRow,
  ExpenseWithRelations,
  IExpenseRepository,
} from '../../src/modules/expense/repository/expense.repository.js';
import type {
  FriendRequestWithUsers,
  FriendshipWithUsers,
  IFriendRepository,
  SearchFilter,
} from '../../src/modules/friend/repository/friend.repository.js';
import { ActivityService } from '../../src/modules/activity/index.js';
import type { ActivityRepository } from '../../src/modules/activity/index.js';
import type { LimitEvaluationService } from '../../src/modules/entitlement/service/limit-evaluation.service.js';
import type { IDeviceTokenRepository } from '../../src/modules/notification/repository/device-token.repository.js';
import { NotificationService } from '../../src/modules/notification/service/notification.service.js';
import type { SettlementWithUsers } from '../../src/modules/settlement/mapper/settlement.mapper.js';
import type {
  CreateSettlementData,
  ISettlementRepository,
  SettlementForBalance,
} from '../../src/modules/settlement/repository/settlement.repository.js';
import type {
  CreateTripData,
  ITripRepository,
  TripDetailRow,
  TripListRow,
  TripMemberWithUser,
  UpdateTripData,
} from '../../src/modules/trip/repository/trip.repository.js';
import type { PaginationParams } from '../../src/database/helpers.js';

export class FakeStore {
  users = new Map<string, User>();
  refreshTokens = new Map<string, RefreshToken>(); // key: tokenHash
  trips = new Map<string, Trip>();
  tripMembers = new Map<string, TripMember>(); // key: `${tripId}:${userId}`
  expenses = new Map<string, Expense>();
  expensePayments = new Map<string, ExpensePayment>(); // key: paymentId
  expenseParticipants = new Map<string, ExpenseParticipant>(); // key: `${expenseId}:${userId}`
  friendships = new Map<string, Friendship>(); // key: `${userAId}:${userBId}` (canonical)
  friendRequests = new Map<string, FriendRequest>(); // key: requestId
  settlements = new Map<string, Settlement>(); // key: settlementId
  /**
   * Generate a fresh UUID. We don't prefix per-table because the schema
   * validators expect UUID-shaped IDs (`@db.Uuid`); using the same
   * generator everywhere also keeps the smoke test indistinguishable
   * from a real Postgres run.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  newId(): string {
    return randomUUID();
  }
}

// ── User repo ────────────────────────────────────────────────────────────────

export class FakeUserRepository implements IUserRepository {
  constructor(private readonly store: FakeStore) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async findById(id: string): Promise<User | null> {
    const u = this.store.users.get(id);
    if (u === undefined || u.deletedAt !== null) return null;
    return u;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findManyByIds(ids: readonly string[]): Promise<User[]> {
    return ids
      .map((id) => this.store.users.get(id))
      .filter((u): u is User => u !== undefined && u.deletedAt === null);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findByFirebaseUid(firebaseUid: string): Promise<User | null> {
    for (const u of this.store.users.values()) {
      if (u.firebaseUid === firebaseUid && u.deletedAt === null) return u;
    }
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findByPhone(phone: string): Promise<User | null> {
    for (const u of this.store.users.values()) {
      if (u.phone === phone && u.deletedAt === null) return u;
    }
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findByHandle(handle: string): Promise<User | null> {
    for (const u of this.store.users.values()) {
      if (u.handle === handle && u.deletedAt === null) return u;
    }
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async create(input: CreateUserInput): Promise<User> {
    const now = new Date();
    const user: User = {
      id: this.store.newId(),
      firebaseUid: input.firebaseUid,
      email: input.email,
      phone: null,
      handle: input.handle,
      name: input.name,
      avatarColor: input.avatarColor,
      avatarUrl: input.avatarUrl ?? null,
      upiId: null,
      // Subscription / entitlement fields — free-tier defaults. (Legacy Phase 1
      // fields plus the Phase 2A premiumExpiresAt cache.)
      isPremium: false,
      subscriptionToken: null,
      subscriptionProductId: null,
      subscriptionExpiresAt: null,
      premiumExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.store.users.set(user.id, user);
    return user;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async update(id: string, input: UpdateUserInput): Promise<User> {
    const cur = this.store.users.get(id);
    if (cur === undefined) throw new Error('user not found');
    const next: User = {
      ...cur,
      name: input.name ?? cur.name,
      handle: input.handle ?? cur.handle,
      avatarColor: input.avatarColor ?? cur.avatarColor,
      upiId: input.upiId === undefined ? cur.upiId : input.upiId,
      avatarUrl: input.avatarUrl === undefined ? cur.avatarUrl : input.avatarUrl,
      phone: input.phone === undefined ? cur.phone : input.phone,
      updatedAt: new Date(),
    };
    this.store.users.set(id, next);
    return next;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async softDelete(id: string): Promise<User> {
    const cur = this.store.users.get(id);
    if (cur === undefined) throw new Error('user not found');
    const anonHandle = `deleted_${id.replace(/-/g, '').slice(0, 16)}`;
    const next: User = {
      ...cur,
      name: 'Deleted User',
      email: null,
      phone: null,
      avatarUrl: null,
      upiId: null,
      firebaseUid: null,
      handle: anonHandle,
      deletedAt: new Date(),
      updatedAt: new Date(),
    };
    this.store.users.set(id, next);
    return next;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async hasOutstandingBalance(_userId: string): Promise<boolean> {
    // Smoke-test stub — always returns false (no dues) so delete flows proceed.
    return false;
  }
}

// ── RefreshToken repo ────────────────────────────────────────────────────────

export class FakeRefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private readonly store: FakeStore) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async create(input: CreateRefreshTokenInput): Promise<RefreshToken> {
    const now = new Date();
    const row: RefreshToken = {
      id: this.store.newId(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.refreshTokens.set(input.tokenHash, row);
    return row;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findActiveByHash(tokenHash: string): Promise<RefreshToken | null> {
    const row = this.store.refreshTokens.get(tokenHash);
    if (row === undefined) return null;
    if (row.revokedAt !== null) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async revokeById(id: string): Promise<RefreshToken> {
    for (const row of this.store.refreshTokens.values()) {
      if (row.id === id) {
        row.revokedAt = new Date();
        return row;
      }
    }
    throw new Error('refresh token not found');
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async revokeByHash(tokenHash: string): Promise<RefreshToken | null> {
    const row = this.store.refreshTokens.get(tokenHash);
    if (row === undefined) return null;
    if (row.revokedAt === null) row.revokedAt = new Date();
    return row;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async revokeAllForUser(userId: string): Promise<number> {
    let n = 0;
    for (const row of this.store.refreshTokens.values()) {
      if (row.userId === userId && row.revokedAt === null) {
        row.revokedAt = new Date();
        n += 1;
      }
    }
    return n;
  }
}

// ── Trip repo ────────────────────────────────────────────────────────────────

function memberKey(tripId: string, userId: string): string {
  return `${tripId}:${userId}`;
}

export class FakeTripRepository implements ITripRepository {
  constructor(private readonly store: FakeStore) {}

  private hydrateMember(row: TripMember): TripMemberWithUser {
    const user = this.store.users.get(row.userId);
    if (user === undefined) throw new Error(`hydrate: user ${row.userId} missing`);
    return { ...row, user };
  }

  private membersFor(tripId: string): TripMemberWithUser[] {
    const rows = Array.from(this.store.tripMembers.values()).filter((m) => m.tripId === tripId);
    rows.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
    return rows.map((r) => this.hydrateMember(r));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async create(data: CreateTripData): Promise<TripDetailRow> {
    const now = new Date();
    const trip: Trip = {
      id: this.store.newId(),
      name: data.name,
      emoji: data.emoji,
      coverColor: data.coverColor,
      description: data.description,
      createdById: data.createdById,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.store.trips.set(trip.id, trip);

    const ownerRow: TripMember = {
      id: this.store.newId(),
      tripId: trip.id,
      userId: data.createdById,
      role: 'OWNER' as TripMemberRole,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.store.tripMembers.set(memberKey(trip.id, data.createdById), ownerRow);

    const extras = Array.from(new Set(data.memberIds)).filter((id) => id !== data.createdById);
    for (const userId of extras) {
      const row: TripMember = {
        id: this.store.newId(),
        tripId: trip.id,
        userId,
        role: 'MEMBER' as TripMemberRole,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      this.store.tripMembers.set(memberKey(trip.id, userId), row);
    }

    return {
      ...trip,
      members: this.membersFor(trip.id),
      totalAmountMinor: 0,
      latestExpenseAt: null,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findById(tripId: string): Promise<Trip | null> {
    const t = this.store.trips.get(tripId);
    if (t === undefined || t.deletedAt !== null) return null;
    return t;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findDetail(tripId: string): Promise<TripDetailRow | null> {
    const t = this.store.trips.get(tripId);
    if (t === undefined || t.deletedAt !== null) return null;
    return {
      ...t,
      members: this.membersFor(tripId),
      totalAmountMinor: 0, // expense module fills this in
      latestExpenseAt: null,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listForUser(
    userId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: TripListRow[]; total: number }> {
    const tripIds = new Set<string>();
    for (const m of this.store.tripMembers.values()) {
      if (m.userId === userId) tripIds.add(m.tripId);
    }
    const trips = Array.from(this.store.trips.values()).filter(
      (t) => tripIds.has(t.id) && t.deletedAt === null,
    );
    trips.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    const page = trips.slice(pagination.skip, pagination.skip + pagination.take);
    const rows: TripListRow[] = page.map((t) => ({
      ...t,
      members: this.membersFor(t.id),
      totalAmountMinor: 0,
      latestExpenseAt: null,
    }));
    return { rows, total: trips.length };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async update(tripId: string, data: UpdateTripData): Promise<Trip> {
    const cur = this.store.trips.get(tripId);
    if (cur === undefined) throw new Error('trip not found');
    const next: Trip = {
      ...cur,
      name: data.name ?? cur.name,
      emoji: data.emoji ?? cur.emoji,
      coverColor: data.coverColor ?? cur.coverColor,
      description: data.description === undefined ? cur.description : data.description,
      updatedAt: new Date(),
    };
    this.store.trips.set(tripId, next);
    return next;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async softDelete(tripId: string): Promise<Trip> {
    const cur = this.store.trips.get(tripId);
    if (cur === undefined) throw new Error('trip not found');
    const next: Trip = { ...cur, deletedAt: new Date(), updatedAt: new Date() };
    this.store.trips.set(tripId, next);
    return next;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findMembership(tripId: string, userId: string): Promise<TripMember | null> {
    return this.store.tripMembers.get(memberKey(tripId, userId)) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async addMembers(
    tripId: string,
    userIds: readonly string[],
  ): Promise<TripMemberWithUser[]> {
    const unique = Array.from(new Set(userIds));
    const now = new Date();
    for (const userId of unique) {
      const k = memberKey(tripId, userId);
      if (this.store.tripMembers.has(k)) continue;
      const row: TripMember = {
        id: this.store.newId(),
        tripId,
        userId,
        role: 'MEMBER' as TripMemberRole,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      this.store.tripMembers.set(k, row);
    }
    return unique
      .map((u) => this.store.tripMembers.get(memberKey(tripId, u)))
      .filter((r): r is TripMember => r !== undefined)
      .map((r) => this.hydrateMember(r));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async removeMember(tripId: string, userId: string): Promise<void> {
    this.store.tripMembers.delete(memberKey(tripId, userId));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async countActiveUsers(userIds: readonly string[]): Promise<number> {
    let n = 0;
    for (const id of userIds) {
      const u = this.store.users.get(id);
      if (u !== undefined && u.deletedAt === null) n += 1;
    }
    return n;
  }
}

// ── Expense repo ─────────────────────────────────────────────────────────────

function participantKey(expenseId: string, userId: string): string {
  return `${expenseId}:${userId}`;
}

export class FakeExpenseRepository implements IExpenseRepository {
  constructor(private readonly store: FakeStore) {}

  private hydrate(row: Expense): ExpenseWithRelations {
    const payments = Array.from(this.store.expensePayments.values())
      .filter((p) => p.expenseId === row.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => {
        const user = this.store.users.get(p.userId);
        if (user === undefined) throw new Error(`hydrate: payer ${p.userId} missing`);
        return { ...p, user };
      });
    const participants = Array.from(this.store.expenseParticipants.values())
      .filter((p) => p.expenseId === row.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => {
        const user = this.store.users.get(p.userId);
        if (user === undefined) throw new Error(`hydrate: participant ${p.userId} missing`);
        return { ...p, user };
      });
    return { ...row, payments, participants };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async create(data: CreateExpenseData): Promise<ExpenseWithRelations> {
    const now = new Date();
    const expense: Expense = {
      id: this.store.newId(),
      tripId: data.tripId,
      title: data.title,
      amountMinor: data.amountMinor,
      category: data.category,
      splitType: data.splitType,
      // splitMeta is null for EQUAL splits — the audit snapshot is only
      // populated by the service layer for non-EQUAL split types.
      splitMeta: null,
      createdById: data.createdById,
      spentAt: data.spentAt,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.store.expenses.set(expense.id, expense);
    for (const pay of data.payments) {
      const payment: ExpensePayment = {
        id: this.store.newId(),
        expenseId: expense.id,
        userId: pay.userId,
        contributionMinor: pay.contributionMinor,
        paymentMeta: null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.expensePayments.set(payment.id, payment);
    }
    for (const s of data.shares) {
      const p: ExpenseParticipant = {
        id: this.store.newId(),
        expenseId: expense.id,
        userId: s.userId,
        shareMinor: s.shareMinor,
        // Audit metadata fields: null for EQUAL splits. Non-EQUAL splits have
        // exactly one of these set; the DB enforces single_meta_chk constraint.
        basisPoints: s.basisPoints,
        shareUnits: s.shareUnits,
        exactAmountMinor: s.exactAmountMinor,
        createdAt: now,
        updatedAt: now,
      };
      this.store.expenseParticipants.set(participantKey(expense.id, s.userId), p);
    }
    return this.hydrate(expense);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findById(expenseId: string): Promise<ExpenseWithRelations | null> {
    const e = this.store.expenses.get(expenseId);
    if (e === undefined || e.deletedAt !== null) return null;
    return this.hydrate(e);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listByTrip(
    tripId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: ExpenseWithRelations[]; total: number }> {
    const all = Array.from(this.store.expenses.values()).filter(
      (e) => e.tripId === tripId && e.deletedAt === null,
    );
    all.sort((a, b) => {
      if (a.spentAt.getTime() !== b.spentAt.getTime()) {
        return b.spentAt.getTime() - a.spentAt.getTime();
      }
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
    const page = all.slice(pagination.skip, pagination.skip + pagination.take);
    return { rows: page.map((e) => this.hydrate(e)), total: all.length };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findForBalances(tripId: string): Promise<ExpenseAggregateRow[]> {
    const rows = Array.from(this.store.expenses.values()).filter(
      (e) => e.tripId === tripId && e.deletedAt === null,
    );
    rows.sort((a, b) => a.spentAt.getTime() - b.spentAt.getTime());
    return rows.map((e) => {
      const payments = Array.from(this.store.expensePayments.values())
        .filter((p) => p.expenseId === e.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((p) => ({ userId: p.userId, contributionMinor: p.contributionMinor }));
      const participants = Array.from(this.store.expenseParticipants.values())
        .filter((p) => p.expenseId === e.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((p) => ({ userId: p.userId, shareMinor: p.shareMinor }));
      return {
        expenseId: e.id,
        amountMinor: e.amountMinor,
        payments,
        participants,
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findViewerTotalsByTrip(
    tripIds: readonly string[],
    userId: string,
  ): Promise<Map<string, { paidMinor: number; shareMinor: number }>> {
    const ids = new Set(tripIds);
    const totals = new Map<string, { paidMinor: number; shareMinor: number }>();
    for (const e of this.store.expenses.values()) {
      if (e.deletedAt !== null || !ids.has(e.tripId)) continue;
      const acc = totals.get(e.tripId) ?? { paidMinor: 0, shareMinor: 0 };
      for (const p of this.store.expensePayments.values()) {
        if (p.expenseId === e.id && p.userId === userId) acc.paidMinor += p.contributionMinor;
      }
      for (const p of this.store.expenseParticipants.values()) {
        if (p.expenseId === e.id && p.userId === userId) acc.shareMinor += p.shareMinor;
      }
      totals.set(e.tripId, acc);
    }
    return totals;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async softDelete(expenseId: string): Promise<Expense> {
    const cur = this.store.expenses.get(expenseId);
    if (cur === undefined) throw new Error('expense not found');
    const next: Expense = { ...cur, deletedAt: new Date(), updatedAt: new Date() };
    this.store.expenses.set(expenseId, next);
    return next;
  }
}

// ── Friend repo ──────────────────────────────────────────────────────────────

function friendshipKey(userAId: string, userBId: string): string {
  return `${userAId}:${userBId}`;
}

export class FakeFriendRepository implements IFriendRepository {
  constructor(private readonly store: FakeStore) {}

  private hydrateFriendship(row: Friendship): FriendshipWithUsers {
    const userA = this.store.users.get(row.userAId);
    const userB = this.store.users.get(row.userBId);
    if (userA === undefined || userB === undefined) {
      throw new Error('hydrateFriendship: user missing');
    }
    return { ...row, userA, userB };
  }

  private hydrateRequest(row: FriendRequest): FriendRequestWithUsers {
    const fromUser = this.store.users.get(row.fromUserId);
    const toUser = this.store.users.get(row.toUserId);
    if (fromUser === undefined || toUser === undefined) {
      throw new Error('hydrateRequest: user missing');
    }
    return { ...row, fromUser, toUser };
  }

  // ── Friendships ──────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/require-await
  async listFriends(
    userId: string,
    take: number,
    skip: number,
  ): Promise<FriendshipWithUsers[]> {
    const all = Array.from(this.store.friendships.values()).filter(
      (f) => f.userAId === userId || f.userBId === userId,
    );
    all.sort((a, b) => b.since.getTime() - a.since.getTime());
    return all.slice(skip, skip + take).map((f) => this.hydrateFriendship(f));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async countFriends(userId: string): Promise<number> {
    let n = 0;
    for (const f of this.store.friendships.values()) {
      if (f.userAId === userId || f.userBId === userId) n += 1;
    }
    return n;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findFriendship(userIdA: string, userIdB: string): Promise<Friendship | null> {
    if (userIdA === userIdB) return null;
    const pair = canonicalFriendshipPair(userIdA, userIdB);
    return this.store.friendships.get(friendshipKey(pair.userAId, pair.userBId)) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createFriendship(userIdA: string, userIdB: string): Promise<Friendship> {
    const pair = canonicalFriendshipPair(userIdA, userIdB);
    const now = new Date();
    const row: Friendship = {
      id: this.store.newId(),
      userAId: pair.userAId,
      userBId: pair.userBId,
      since: now,
      createdAt: now,
      updatedAt: now,
    };
    this.store.friendships.set(friendshipKey(pair.userAId, pair.userBId), row);
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async removeFriendship(userIdA: string, userIdB: string): Promise<void> {
    const pair = canonicalFriendshipPair(userIdA, userIdB);
    this.store.friendships.delete(friendshipKey(pair.userAId, pair.userBId));
  }

  // ── Requests ─────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/require-await
  async findFriendshipsBetween(
    viewerId: string,
    otherIds: string[],
  ): Promise<Friendship[]> {
    if (otherIds.length === 0) return [];
    const others = new Set(otherIds);
    const out: Friendship[] = [];
    for (const f of this.store.friendships.values()) {
      if (f.userAId === viewerId && others.has(f.userBId)) out.push(f);
      else if (f.userBId === viewerId && others.has(f.userAId)) out.push(f);
    }
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findActiveRequestsBetween(
    viewerId: string,
    otherIds: string[],
  ): Promise<FriendRequest[]> {
    if (otherIds.length === 0) return [];
    const others = new Set(otherIds);
    const out: FriendRequest[] = [];
    for (const r of this.store.friendRequests.values()) {
      if (r.status !== FriendRequestStatus.PENDING) continue;
      if (r.fromUserId === viewerId && others.has(r.toUserId)) out.push(r);
      else if (r.toUserId === viewerId && others.has(r.fromUserId)) out.push(r);
    }
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findRequestByDirection(
    fromUserId: string,
    toUserId: string,
  ): Promise<FriendRequest | null> {
    for (const r of this.store.friendRequests.values()) {
      if (r.fromUserId === fromUserId && r.toUserId === toUserId) return r;
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createRequest(
    fromUserId: string,
    toUserId: string,
    message: string | null,
  ): Promise<FriendRequestWithUsers> {
    const now = new Date();
    const row: FriendRequest = {
      id: this.store.newId(),
      fromUserId,
      toUserId,
      status: FriendRequestStatus.PENDING,
      message,
      respondedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.friendRequests.set(row.id, row);
    return this.hydrateRequest(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async reopenRequest(
    requestId: string,
    message: string | null,
  ): Promise<FriendRequestWithUsers> {
    const cur = this.store.friendRequests.get(requestId);
    if (cur === undefined) throw new Error('request not found');
    const next: FriendRequest = {
      ...cur,
      status: FriendRequestStatus.PENDING,
      message,
      respondedAt: null,
      updatedAt: new Date(),
    };
    this.store.friendRequests.set(requestId, next);
    return this.hydrateRequest(next);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findRequestById(requestId: string): Promise<FriendRequestWithUsers | null> {
    const row = this.store.friendRequests.get(requestId);
    return row === undefined ? null : this.hydrateRequest(row);
  }

  async acceptRequestAndCreateFriendship(
    requestId: string,
  ): Promise<{ request: FriendRequestWithUsers; friendship: Friendship }> {
    const cur = this.store.friendRequests.get(requestId);
    if (cur === undefined) throw new Error('request not found');
    const updated: FriendRequest = {
      ...cur,
      status: FriendRequestStatus.ACCEPTED,
      respondedAt: new Date(),
      updatedAt: new Date(),
    };
    this.store.friendRequests.set(requestId, updated);

    const pair = canonicalFriendshipPair(cur.fromUserId, cur.toUserId);
    const key = friendshipKey(pair.userAId, pair.userBId);
    let friendship = this.store.friendships.get(key);
    if (friendship === undefined) {
      friendship = await this.createFriendship(pair.userAId, pair.userBId);
    }
    return { request: this.hydrateRequest(updated), friendship };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async rejectRequest(requestId: string): Promise<FriendRequestWithUsers> {
    const cur = this.store.friendRequests.get(requestId);
    if (cur === undefined) throw new Error('request not found');
    const next: FriendRequest = {
      ...cur,
      status: FriendRequestStatus.DECLINED,
      respondedAt: new Date(),
      updatedAt: new Date(),
    };
    this.store.friendRequests.set(requestId, next);
    return this.hydrateRequest(next);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancelRequest(requestId: string): Promise<FriendRequestWithUsers> {
    const cur = this.store.friendRequests.get(requestId);
    if (cur === undefined) throw new Error('request not found');
    const next: FriendRequest = {
      ...cur,
      status: FriendRequestStatus.CANCELLED,
      respondedAt: new Date(),
      updatedAt: new Date(),
    };
    this.store.friendRequests.set(requestId, next);
    return this.hydrateRequest(next);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async countPendingIncoming(userId: string): Promise<number> {
    return Array.from(this.store.friendRequests.values()).filter(
      (r) => r.toUserId === userId && r.status === FriendRequestStatus.PENDING,
    ).length;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listIncoming(userId: string): Promise<FriendRequestWithUsers[]> {
    const rows = Array.from(this.store.friendRequests.values()).filter(
      (r) => r.toUserId === userId && r.status === FriendRequestStatus.PENDING,
    );
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows.map((r) => this.hydrateRequest(r));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listOutgoing(userId: string): Promise<FriendRequestWithUsers[]> {
    const rows = Array.from(this.store.friendRequests.values()).filter(
      (r) => r.fromUserId === userId && r.status === FriendRequestStatus.PENDING,
    );
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return rows.map((r) => this.hydrateRequest(r));
  }

  // ── Search ───────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/require-await
  async searchUsers(filter: SearchFilter): Promise<User[]> {
    const q = filter.q.toLowerCase();
    const results: User[] = [];
    for (const u of this.store.users.values()) {
      if (u.id === filter.excludeUserId) continue;
      if (u.deletedAt !== null) continue;
      const hay = `${u.name.toLowerCase()}|${u.handle.toLowerCase()}|${u.phone ?? ''}`;
      if (hay.includes(q)) results.push(u);
      if (results.length >= filter.limit) break;
    }
    results.sort((a, b) => a.handle.localeCompare(b.handle));
    return results;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findUsersByPhoneSuffixes(suffixes: string[], excludeUserId: string): Promise<User[]> {
    const results: User[] = [];
    for (const u of this.store.users.values()) {
      if (u.id === excludeUserId || u.deletedAt !== null || u.phone === null) continue;
      if (suffixes.some((s) => u.phone!.endsWith(s))) results.push(u);
      if (results.length >= 200) break;
    }
    return results;
  }
}

// ── Settlement repo ──────────────────────────────────────────────────────────

export class FakeSettlementRepository implements ISettlementRepository {
  constructor(private readonly store: FakeStore) {}

  private hydrate(row: Settlement): SettlementWithUsers {
    const fromUser = this.store.users.get(row.fromUserId);
    const toUser = this.store.users.get(row.toUserId);
    if (fromUser === undefined || toUser === undefined) {
      throw new Error('hydrateSettlement: user missing');
    }
    return { ...row, fromUser, toUser };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async create(data: CreateSettlementData): Promise<SettlementWithUsers> {
    const now = new Date();
    const row: Settlement = {
      id: this.store.newId(),
      tripId: data.tripId,
      fromUserId: data.fromUserId,
      toUserId: data.toUserId,
      amountMinor: data.amountMinor,
      status: SettlementStatus.COMPLETED,
      method: data.method,
      note: data.note,
      externalRef: data.externalRef,
      settledAt: now,
      createdById: data.createdById,
      createdAt: now,
      updatedAt: now,
    };
    this.store.settlements.set(row.id, row);
    return this.hydrate(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findById(id: string): Promise<SettlementWithUsers | null> {
    const row = this.store.settlements.get(id);
    return row === undefined ? null : this.hydrate(row);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listByTrip(
    tripId: string,
    pagination: PaginationParams,
  ): Promise<{ rows: SettlementWithUsers[]; total: number }> {
    const all = Array.from(this.store.settlements.values()).filter((s) => s.tripId === tripId);
    all.sort((a, b) => {
      const aTs = (a.settledAt ?? a.createdAt).getTime();
      const bTs = (b.settledAt ?? b.createdAt).getTime();
      if (aTs !== bTs) return bTs - aTs;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
    const page = all.slice(pagination.skip, pagination.skip + pagination.take);
    return { rows: page.map((r) => this.hydrate(r)), total: all.length };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findCompletedForBalances(tripId: string): Promise<SettlementForBalance[]> {
    const rows = Array.from(this.store.settlements.values())
      .filter((s) => s.tripId === tripId && s.status === SettlementStatus.COMPLETED)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return rows.map((r) => ({
      fromUserId: r.fromUserId,
      toUserId: r.toUserId,
      amountMinor: r.amountMinor,
    }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findViewerTotalsByTrip(
    tripIds: readonly string[],
    userId: string,
  ): Promise<Map<string, { settledOutMinor: number; settledInMinor: number }>> {
    const ids = new Set(tripIds);
    const totals = new Map<string, { settledOutMinor: number; settledInMinor: number }>();
    for (const s of this.store.settlements.values()) {
      if (s.status !== SettlementStatus.COMPLETED || !ids.has(s.tripId)) continue;
      if (s.fromUserId !== userId && s.toUserId !== userId) continue;
      const acc = totals.get(s.tripId) ?? { settledOutMinor: 0, settledInMinor: 0 };
      if (s.fromUserId === userId) acc.settledOutMinor += s.amountMinor;
      if (s.toUserId === userId) acc.settledInMinor += s.amountMinor;
      totals.set(s.tripId, acc);
    }
    return totals;
  }
}

// ── Device-token / Notification stubs ────────────────────────────────────────

class FakeDeviceTokenRepository implements IDeviceTokenRepository {
  // eslint-disable-next-line @typescript-eslint/require-await
  async upsert(_userId: string, _token: string, _platform: Platform): Promise<DeviceToken> {
    throw new Error('not implemented in smoke tests');
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(_token: string): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/require-await
  async findByUserId(_userId: string): Promise<DeviceToken[]> { return []; }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findByUserIds(_userIds: string[]): Promise<DeviceToken[]> { return []; }
  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteMany(_tokens: string[]): Promise<void> {}
}

/** Returns a no-op NotificationService suitable for smoke tests (FCM not configured). */
export function buildNotificationService(): NotificationService {
  return new NotificationService(new FakeDeviceTokenRepository());
}

/** No-op activity repository — swallows writes, returns an empty feed. */
class FakeActivityRepository implements ActivityRepository {
  // eslint-disable-next-line @typescript-eslint/require-await
  async createMany(): Promise<number> { return 0; }
  // eslint-disable-next-line @typescript-eslint/require-await
  async listForUser(): Promise<Activity[]> { return []; }
}

/** Returns a no-op ActivityService suitable for smoke tests. */
export function buildActivityService(): ActivityService {
  return new ActivityService(new FakeActivityRepository());
}

/**
 * Permissive LimitEvaluationService for smoke tests that exercise trip CRUD but
 * not entitlement enforcement — enforcement is a no-op (always allowed). The
 * dedicated enforcement smoke tests the real limit logic separately.
 */
export function buildNoopLimits(): LimitEvaluationService {
  return {
    enforceGroupCreation: async () => {},
    evaluateGroupCreation: async () => ({ allowed: true, premium: true, usage: null, limit: null }),
  } as unknown as LimitEvaluationService;
}
