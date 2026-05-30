import type {
  FriendRequest,
  Friendship,
  PrismaClient,
  User,
} from '@prisma/client';
import { FriendRequestStatus, Prisma } from '@prisma/client';
import { canonicalFriendshipPair } from '../../../database/helpers.js';
import { notDeleted } from '../../../database/constants.js';

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface FriendshipWithUsers extends Friendship {
  userA: User;
  userB: User;
}

export interface FriendRequestWithUsers extends FriendRequest {
  fromUser: User;
  toUser: User;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface SearchFilter {
  /** Already-trimmed and validated; lowercased before regex/LIKE. */
  q: string;
  excludeUserId: string;
  limit: number;
}

// ── Interface + impl ─────────────────────────────────────────────────────────

export interface IFriendRepository {
  // Friendships
  listFriends(userId: string, take: number, skip: number): Promise<FriendshipWithUsers[]>;
  countFriends(userId: string): Promise<number>;
  findFriendship(userIdA: string, userIdB: string): Promise<Friendship | null>;
  createFriendship(userIdA: string, userIdB: string): Promise<Friendship>;
  removeFriendship(userIdA: string, userIdB: string): Promise<void>;

  // Requests
  /**
   * Batch lookup: return every accepted friendship between `viewerId`
   * and any of `otherIds`. Used by the shared decorator to attach
   * "friend / pending / none" relationship state to a list of users
   * without N+1 queries.
   */
  findFriendshipsBetween(
    viewerId: string,
    otherIds: string[],
  ): Promise<Friendship[]>;
  /**
   * Batch lookup: return every PENDING request where `viewerId` is on
   * one side and the other side is in `otherIds`. Direction-agnostic;
   * callers inspect `fromUserId`/`toUserId` to derive outgoing vs incoming.
   */
  findActiveRequestsBetween(
    viewerId: string,
    otherIds: string[],
  ): Promise<FriendRequest[]>;
  /**
   * Returns the row stored at the (fromUserId, toUserId) UNIQUE index —
   * regardless of status. Used by `sendRequest` to decide between
   * inserting fresh vs. reopening an old DECLINED/CANCELLED row.
   */
  findRequestByDirection(
    fromUserId: string,
    toUserId: string,
  ): Promise<FriendRequest | null>;
  createRequest(
    fromUserId: string,
    toUserId: string,
    message: string | null,
  ): Promise<FriendRequestWithUsers>;
  /**
   * Re-open a previously DECLINED / CANCELLED request rather than
   * inserting a duplicate (would violate the (fromUserId, toUserId)
   * unique index). Used by `sendRequest` when an old row blocks the path.
   */
  reopenRequest(
    requestId: string,
    message: string | null,
  ): Promise<FriendRequestWithUsers>;
  findRequestById(requestId: string): Promise<FriendRequestWithUsers | null>;
  acceptRequestAndCreateFriendship(
    requestId: string,
  ): Promise<{ request: FriendRequestWithUsers; friendship: Friendship }>;
  rejectRequest(requestId: string): Promise<FriendRequestWithUsers>;
  /** Sender-side cancellation. Sets status=CANCELLED, respondedAt=now. */
  cancelRequest(requestId: string): Promise<FriendRequestWithUsers>;
  listIncoming(userId: string): Promise<FriendRequestWithUsers[]>;
  listOutgoing(userId: string): Promise<FriendRequestWithUsers[]>;

  // Search
  searchUsers(filter: SearchFilter): Promise<User[]>;

  // Contacts
  findUsersByPhoneSuffixes(suffixes: string[], excludeUserId: string): Promise<User[]>;
}

const friendInclude = {
  userA: true,
  userB: true,
} satisfies Prisma.FriendshipInclude;

const requestInclude = {
  fromUser: true,
  toUser: true,
} satisfies Prisma.FriendRequestInclude;

export class FriendRepository implements IFriendRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ── Friendships ──────────────────────────────────────────────────────────

  listFriends(userId: string, take: number, skip: number): Promise<FriendshipWithUsers[]> {
    return this.prisma.friendship.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      include: friendInclude,
      orderBy: { since: 'desc' },
      take,
      skip,
    });
  }

  countFriends(userId: string): Promise<number> {
    return this.prisma.friendship.count({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
    });
  }

  findFriendship(userIdA: string, userIdB: string): Promise<Friendship | null> {
    if (userIdA === userIdB) return Promise.resolve(null);
    const pair = canonicalFriendshipPair(userIdA, userIdB);
    return this.prisma.friendship.findUnique({
      where: { userAId_userBId: pair },
    });
  }

  createFriendship(userIdA: string, userIdB: string): Promise<Friendship> {
    const pair = canonicalFriendshipPair(userIdA, userIdB);
    return this.prisma.friendship.create({ data: pair });
  }

  async removeFriendship(userIdA: string, userIdB: string): Promise<void> {
    const pair = canonicalFriendshipPair(userIdA, userIdB);
    await this.prisma.friendship.deleteMany({
      where: { userAId: pair.userAId, userBId: pair.userBId },
    });
  }

  // ── Requests ─────────────────────────────────────────────────────────────

  async findFriendshipsBetween(
    viewerId: string,
    otherIds: string[],
  ): Promise<Friendship[]> {
    if (otherIds.length === 0) return [];
    return this.prisma.friendship.findMany({
      where: {
        OR: [
          { userAId: viewerId, userBId: { in: otherIds } },
          { userBId: viewerId, userAId: { in: otherIds } },
        ],
      },
    });
  }

  async findActiveRequestsBetween(
    viewerId: string,
    otherIds: string[],
  ): Promise<FriendRequest[]> {
    if (otherIds.length === 0) return [];
    return this.prisma.friendRequest.findMany({
      where: {
        status: FriendRequestStatus.PENDING,
        OR: [
          { fromUserId: viewerId, toUserId: { in: otherIds } },
          { toUserId: viewerId, fromUserId: { in: otherIds } },
        ],
      },
    });
  }

  findRequestByDirection(
    fromUserId: string,
    toUserId: string,
  ): Promise<FriendRequest | null> {
    return this.prisma.friendRequest.findUnique({
      where: { fromUserId_toUserId: { fromUserId, toUserId } },
    });
  }

  createRequest(
    fromUserId: string,
    toUserId: string,
    message: string | null,
  ): Promise<FriendRequestWithUsers> {
    return this.prisma.friendRequest.create({
      data: {
        fromUserId,
        toUserId,
        message,
        status: FriendRequestStatus.PENDING,
      },
      include: requestInclude,
    });
  }

  reopenRequest(
    requestId: string,
    message: string | null,
  ): Promise<FriendRequestWithUsers> {
    return this.prisma.friendRequest.update({
      where: { id: requestId },
      data: {
        status: FriendRequestStatus.PENDING,
        message,
        respondedAt: null,
      },
      include: requestInclude,
    });
  }

  findRequestById(requestId: string): Promise<FriendRequestWithUsers | null> {
    return this.prisma.friendRequest.findUnique({
      where: { id: requestId },
      include: requestInclude,
    });
  }

  /**
   * Atomic accept: move FriendRequest → ACCEPTED + insert canonical
   * Friendship row in one transaction. The friendship `findUnique` skip
   * is a defense against the (rare) case where two devices accept the
   * same request at the same time and the unique index would explode.
   */
  async acceptRequestAndCreateFriendship(
    requestId: string,
  ): Promise<{ request: FriendRequestWithUsers; friendship: Friendship }> {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.friendRequest.update({
        where: { id: requestId },
        data: {
          status: FriendRequestStatus.ACCEPTED,
          respondedAt: new Date(),
        },
        include: requestInclude,
      });
      const pair = canonicalFriendshipPair(request.fromUserId, request.toUserId);
      const existing = await tx.friendship.findUnique({
        where: { userAId_userBId: pair },
      });
      const friendship =
        existing ??
        (await tx.friendship.create({
          data: pair,
        }));
      return { request, friendship };
    });
  }

  rejectRequest(requestId: string): Promise<FriendRequestWithUsers> {
    return this.prisma.friendRequest.update({
      where: { id: requestId },
      data: {
        status: FriendRequestStatus.DECLINED,
        respondedAt: new Date(),
      },
      include: requestInclude,
    });
  }

  cancelRequest(requestId: string): Promise<FriendRequestWithUsers> {
    return this.prisma.friendRequest.update({
      where: { id: requestId },
      data: {
        status: FriendRequestStatus.CANCELLED,
        respondedAt: new Date(),
      },
      include: requestInclude,
    });
  }

  listIncoming(userId: string): Promise<FriendRequestWithUsers[]> {
    return this.prisma.friendRequest.findMany({
      where: { toUserId: userId, status: FriendRequestStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      include: requestInclude,
    });
  }

  listOutgoing(userId: string): Promise<FriendRequestWithUsers[]> {
    return this.prisma.friendRequest.findMany({
      where: { fromUserId: userId, status: FriendRequestStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      include: requestInclude,
    });
  }

  // ── Search ───────────────────────────────────────────────────────────────

  /**
   * Case-insensitive partial match on `name`, `handle`, and `phone`.
   *
   * Each predicate is indexed:
   *   - `users.name`   has a btree index (Step 1)
   *   - `users.handle` UNIQUE
   *   - `users.phone`  UNIQUE
   *
   * Postgres uses the indexes for prefix patterns (`q%`) directly. For
   * substring patterns (`%q%`) on `name` it falls back to a sequential
   * scan; that's fine at MVP scale — we cap results at SEARCH_MAX_LIMIT
   * and small users tables fit in the buffer cache. Migrate to a
   * `pg_trgm` GIN index if/when the row count makes seq scans painful.
   */
  searchUsers(filter: SearchFilter): Promise<User[]> {
    const q = filter.q.toLowerCase();
    return this.prisma.user.findMany({
      where: {
        ...notDeleted,
        id: { not: filter.excludeUserId },
        OR: [
          { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
          { handle: { contains: q, mode: Prisma.QueryMode.insensitive } },
          { phone: { contains: q } },
        ],
      },
      take: filter.limit,
      orderBy: [{ handle: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * Match registered users by the trailing digits of their stored phone.
   * Each suffix is the last 10 digits of a normalised contact number, so
   * "+91 98765 43210" → "9876543210" matches a stored "9876543210" or
   * "+919876543210".  Capped at 200 results; the caller already deduped
   * and capped the input at 500 suffixes.
   */
  findUsersByPhoneSuffixes(suffixes: string[], excludeUserId: string): Promise<User[]> {
    if (suffixes.length === 0) return Promise.resolve([]);
    return this.prisma.user.findMany({
      where: {
        ...notDeleted,
        id: { not: excludeUserId },
        phone: { not: null },
        OR: suffixes.map((s) => ({ phone: { endsWith: s } })),
      },
      take: 200,
      orderBy: { name: 'asc' },
    });
  }
}
