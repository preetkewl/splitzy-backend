import { FriendRequestStatus, type User } from '@prisma/client';
import { ApiError } from '../../../core/api-error.js';
import { ERROR_CODES } from '../../../constants/error-codes.js';
import { HTTP } from '../../../constants/http.js';
import { paginate, type PaginationInput } from '../../../database/helpers.js';
import { logger } from '../../../utils/logger.js';
import type { ActivityService } from '../../activity/index.js';
import type { IUserRepository } from '../../auth/repository/user.repository.js';
import type { NotificationService } from '../../notification/service/notification.service.js';
import { SEARCH_DEFAULT_LIMIT } from '../constants.js';
import type {
  ContactSyncResultDto,
  FriendDto,
  FriendRequestDto,
  FriendRequestListDto,
  FriendSearchResultDto,
  SendFriendRequestInput,
} from '../dto/index.js';
import {
  toFriendDto,
  toFriendRequestDto,
  toFriendUserPreview,
} from '../mapper/friend.mapper.js';
import type {
  FriendRequestWithUsers,
  IFriendRepository,
} from '../repository/friend.repository.js';

export interface ListFriendsResult {
  items: FriendDto[];
  page: number;
  pageSize: number;
  total: number;
}

export class FriendService {
  constructor(
    private readonly friends: IFriendRepository,
    private readonly users: IUserRepository,
    private readonly notifications: NotificationService,
    private readonly activity: ActivityService,
  ) {}

  // ── list ──────────────────────────────────────────────────────────────────

  async listFriends(userId: string, pagination: PaginationInput): Promise<ListFriendsResult> {
    const params = paginate(pagination);
    const [rows, total] = await Promise.all([
      this.friends.listFriends(userId, params.take, params.skip),
      this.friends.countFriends(userId),
    ]);
    return {
      items: rows.map((r) => toFriendDto(r, userId)),
      page: params.page,
      pageSize: params.pageSize,
      total,
    };
  }

  // ── search ────────────────────────────────────────────────────────────────

  /**
   * Search the directory for potential friends. Returns each match
   * decorated with the relationship between viewer and result so the
   * frontend can render the right CTA without a second round-trip.
   */
  async search(
    viewerUserId: string,
    q: string,
    limit?: number,
  ): Promise<FriendSearchResultDto[]> {
    const users = await this.friends.searchUsers({
      q,
      excludeUserId: viewerUserId,
      limit: limit ?? SEARCH_DEFAULT_LIMIT,
    });
    return this.decorateUsers(viewerUserId, users);
  }

  /**
   * Attach the viewer's current relationship (friend / pending / none)
   * to every user in `others` using **two batched queries total** —
   * regardless of result-set size. Replaces the per-row N+1 fan-out
   * that the older `decorateSearchResult`/`decorateContactResult`
   * implementations used.
   */
  private async decorateUsers(
    viewerUserId: string,
    others: User[],
  ): Promise<FriendSearchResultDto[]> {
    if (others.length === 0) return [];
    const ids = others.map((u) => u.id);
    const [friendships, requests] = await Promise.all([
      this.friends.findFriendshipsBetween(viewerUserId, ids),
      this.friends.findActiveRequestsBetween(viewerUserId, ids),
    ]);

    const friendIds = new Set<string>();
    for (const f of friendships) {
      friendIds.add(f.userAId === viewerUserId ? f.userBId : f.userAId);
    }
    const requestByOther = new Map<string, { id: string; fromMe: boolean }>();
    for (const r of requests) {
      const otherId = r.fromUserId === viewerUserId ? r.toUserId : r.fromUserId;
      requestByOther.set(otherId, { id: r.id, fromMe: r.fromUserId === viewerUserId });
    }

    return others.map((u) => {
      const preview = toFriendUserPreview(u);
      if (friendIds.has(u.id)) {
        return { ...preview, phone: u.phone, relationship: 'friend', requestId: null };
      }
      const req = requestByOther.get(u.id);
      if (req !== undefined) {
        return {
          ...preview,
          phone: u.phone,
          relationship: req.fromMe ? 'request_outgoing' : 'request_incoming',
          requestId: req.id,
        };
      }
      return { ...preview, phone: u.phone, relationship: 'none', requestId: null };
    });
  }

  // ── send request ──────────────────────────────────────────────────────────

  async sendRequest(
    fromUserId: string,
    input: SendFriendRequestInput,
  ): Promise<FriendRequestDto> {
    if (input.targetUserId === fromUserId) {
      throw ApiError.badRequest('Cannot send a friend request to yourself');
    }
    const target = await this.users.findById(input.targetUserId);
    if (target === null) {
      throw ApiError.notFound('User not found');
    }
    const existingFriendship = await this.friends.findFriendship(
      fromUserId,
      input.targetUserId,
    );
    if (existingFriendship !== null) {
      throw new ApiError(
        HTTP.CONFLICT,
        ERROR_CODES.CONFLICT,
        'You are already friends with this user',
      );
    }

    const message = input.message ?? null;

    // 1. Pending request from target → me: don't let me spam them, point
    //    them at the existing incoming row instead.
    const incoming = await this.friends.findRequestByDirection(
      input.targetUserId,
      fromUserId,
    );
    if (incoming !== null && incoming.status === FriendRequestStatus.PENDING) {
      throw new ApiError(
        HTTP.CONFLICT,
        ERROR_CODES.CONFLICT,
        'This user already sent you a request — accept it instead',
      );
    }

    // 2. Existing row from me → target: reopen if DECLINED/CANCELLED,
    //    return idempotently if PENDING.
    const outgoing = await this.friends.findRequestByDirection(
      fromUserId,
      input.targetUserId,
    );
    let result: FriendRequestWithUsers;
    if (outgoing === null) {
      result = await this.friends.createRequest(fromUserId, input.targetUserId, message);
    } else if (outgoing.status === FriendRequestStatus.PENDING) {
      const row = await this.friends.findRequestById(outgoing.id);
      if (row === null) throw ApiError.internal('Request vanished mid-call');
      return toFriendRequestDto(row, fromUserId);
    } else {
      // DECLINED or CANCELLED — reopen the existing row so we don't
      // collide with the (fromUserId, toUserId) UNIQUE index.
      result = await this.friends.reopenRequest(outgoing.id, message);
    }

    logger.info(
      { requestId: result.id, fromUserId, toUserId: input.targetUserId },
      'friend request sent',
    );

    void this.notifications.sendToUser(input.targetUserId, {
      title: 'New friend request',
      body: `${result.fromUser.name} sent you a friend request`,
      type: 'FRIEND_REQUEST',
      data: { senderId: fromUserId, senderName: result.fromUser.name, requestId: result.id },
    });

    return toFriendRequestDto(result, fromUserId);
  }

  // ── accept ────────────────────────────────────────────────────────────────

  async acceptRequest(userId: string, requestId: string): Promise<FriendRequestDto> {
    const request = await this.friends.findRequestById(requestId);
    if (request === null) throw ApiError.notFound('Friend request not found');
    if (request.toUserId !== userId) {
      throw ApiError.forbidden('Only the recipient can accept this request');
    }
    if (request.status !== FriendRequestStatus.PENDING) {
      throw new ApiError(
        HTTP.CONFLICT,
        ERROR_CODES.CONFLICT,
        `Request is already ${request.status.toLowerCase()}`,
      );
    }
    const { request: updated } = await this.friends.acceptRequestAndCreateFriendship(
      requestId,
    );
    logger.info(
      { requestId, fromUserId: updated.fromUserId, toUserId: updated.toUserId },
      'friend request accepted',
    );

    const accepter = await this.users.findById(userId);
    void this.notifications.sendToUser(updated.fromUserId, {
      title: 'Friend request accepted',
      body: `${accepter?.name ?? 'Someone'} accepted your friend request`,
      type: 'FRIEND_ACCEPTED',
      data: { userId },
    });

    // Record activity for both sides (fire-and-forget). The requester gets
    // their own row already; fetch their name for the accepter's row.
    const requester = await this.users.findById(updated.fromUserId);
    this.activity.recordFriendAccepted({
      accepterId: userId,
      accepterName: accepter?.name ?? 'Someone',
      requesterId: updated.fromUserId,
      requesterName: requester?.name ?? 'Someone',
    });

    return toFriendRequestDto(updated, userId);
  }

  // ── reject ────────────────────────────────────────────────────────────────

  async rejectRequest(userId: string, requestId: string): Promise<FriendRequestDto> {
    const request = await this.friends.findRequestById(requestId);
    if (request === null) throw ApiError.notFound('Friend request not found');
    if (request.toUserId !== userId) {
      throw ApiError.forbidden('Only the recipient can reject this request');
    }
    if (request.status !== FriendRequestStatus.PENDING) {
      throw new ApiError(
        HTTP.CONFLICT,
        ERROR_CODES.CONFLICT,
        `Request is already ${request.status.toLowerCase()}`,
      );
    }
    const updated = await this.friends.rejectRequest(requestId);
    logger.info({ requestId, by: userId }, 'friend request rejected');
    return toFriendRequestDto(updated, userId);
  }

  // ── cancel ────────────────────────────────────────────────────────────────

  /**
   * Sender-side cancellation. Mirror of `rejectRequest` but only the
   * `fromUser` may invoke it, and the resulting status is CANCELLED
   * (audit-distinct from DECLINED — so the recipient can tell the
   * difference if we ever surface request history).
   */
  async cancelRequest(userId: string, requestId: string): Promise<FriendRequestDto> {
    const request = await this.friends.findRequestById(requestId);
    if (request === null) throw ApiError.notFound('Friend request not found');
    if (request.fromUserId !== userId) {
      throw ApiError.forbidden('Only the sender can cancel this request');
    }
    if (request.status !== FriendRequestStatus.PENDING) {
      throw new ApiError(
        HTTP.CONFLICT,
        ERROR_CODES.CONFLICT,
        `Request is already ${request.status.toLowerCase()}`,
      );
    }
    const updated = await this.friends.cancelRequest(requestId);
    logger.info({ requestId, by: userId }, 'friend request cancelled');
    return toFriendRequestDto(updated, userId);
  }

  // ── remove friend ────────────────────────────────────────────────────────

  async removeFriend(userId: string, friendUserId: string): Promise<void> {
    if (userId === friendUserId) {
      throw ApiError.badRequest('Cannot remove yourself');
    }
    const friendship = await this.friends.findFriendship(userId, friendUserId);
    if (friendship === null) {
      throw ApiError.notFound('Friendship not found');
    }
    await this.friends.removeFriendship(userId, friendUserId);
    logger.info({ userId, friendUserId }, 'friendship removed');
  }

  // ── contacts sync ─────────────────────────────────────────────────────────

  /**
   * Given raw phone numbers from the device, return matched registered users
   * annotated with relationship state so the client renders the right CTA
   * without extra round-trips.  Normalises to the last 10 digits before
   * matching so "+91-98765-43210" and "9876543210" both resolve correctly.
   */
  async syncContacts(userId: string, phones: string[]): Promise<ContactSyncResultDto> {
    const suffixes = [
      ...new Set(
        phones
          .map((p) => p.replace(/\D/g, '').slice(-10))
          .filter((p) => p.length >= 7),
      ),
    ].slice(0, 500);
    if (suffixes.length === 0) return { matches: [] };

    const users = await this.friends.findUsersByPhoneSuffixes(suffixes, userId);
    return { matches: await this.decorateUsers(userId, users) };
  }

  // ── list requests ─────────────────────────────────────────────────────────

  async listRequests(userId: string): Promise<FriendRequestListDto> {
    const [incoming, outgoing] = await Promise.all([
      this.friends.listIncoming(userId),
      this.friends.listOutgoing(userId),
    ]);
    return {
      incoming: incoming.map((r) => toFriendRequestDto(r, userId)),
      outgoing: outgoing.map((r) => toFriendRequestDto(r, userId)),
    };
  }
}
