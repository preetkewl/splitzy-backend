import { FriendRequestStatus, type User } from '@prisma/client';
import { ApiError } from '../../../core/api-error.js';
import { ERROR_CODES } from '../../../constants/error-codes.js';
import { HTTP } from '../../../constants/http.js';
import { paginate, type PaginationInput } from '../../../database/helpers.js';
import { logger } from '../../../utils/logger.js';
import type { IUserRepository } from '../../auth/repository/user.repository.js';
import { SEARCH_DEFAULT_LIMIT } from '../constants.js';
import type {
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
    if (users.length === 0) return [];

    // For each match, decorate with relationship state. We resolve each
    // pair in parallel — bounded by SEARCH_MAX_LIMIT (50) so the fan-out
    // is harmless. (No N+1 risk: small fixed cap, indexed lookups.)
    return Promise.all(users.map((u) => this.decorateSearchResult(viewerUserId, u)));
  }

  private async decorateSearchResult(
    viewerUserId: string,
    other: User,
  ): Promise<FriendSearchResultDto> {
    const friendship = await this.friends.findFriendship(viewerUserId, other.id);
    if (friendship !== null) {
      return {
        ...toFriendUserPreview(other),
        phone: other.phone,
        relationship: 'friend',
        requestId: null,
      };
    }
    const request = await this.friends.findActiveRequestBetween(viewerUserId, other.id);
    if (request !== null) {
      return {
        ...toFriendUserPreview(other),
        phone: other.phone,
        relationship: request.fromUserId === viewerUserId ? 'request_outgoing' : 'request_incoming',
        requestId: request.id,
      };
    }
    return {
      ...toFriendUserPreview(other),
      phone: other.phone,
      relationship: 'none',
      requestId: null,
    };
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
