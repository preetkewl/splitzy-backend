import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { FriendService } from '../service/friend.service.js';
import type {
  FriendUserIdParam,
  ListFriendsQuery,
  RequestIdParam,
  SearchQuery,
  SendRequestBody,
  SyncContactsBody,
} from '../validation/index.js';

type WithBody<TBody> = Request<Record<string, string>, unknown, TBody>;
type WithParams<TParams extends Record<string, string>> = Request<TParams>;

export class FriendController {
  constructor(private readonly friends: FriendService) {}

  list = asyncHandler(async (req: Request, res: Response) => {
    const userId = this.requireUserId(req);
    const query = req.query as unknown as ListFriendsQuery;
    const result = await this.friends.listFriends(userId, {
      page: query.page,
      pageSize: query.pageSize,
    });
    return ApiResponse.ok(res, result.items, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    });
  });

  search = asyncHandler(async (req: Request, res: Response) => {
    const userId = this.requireUserId(req);
    const query = req.query as unknown as SearchQuery;
    const results = await this.friends.search(userId, query.q, query.limit);
    return ApiResponse.ok(res, results);
  });

  sendRequest = asyncHandler(async (req: WithBody<SendRequestBody>, res: Response) => {
    const userId = this.requireUserId(req);
    const created = await this.friends.sendRequest(userId, {
      targetUserId: req.body.targetUserId,
      message: req.body.message ?? null,
    });
    return ApiResponse.created(res, created);
  });

  acceptRequest = asyncHandler(
    async (req: WithParams<RequestIdParam>, res: Response) => {
      const userId = this.requireUserId(req);
      const result = await this.friends.acceptRequest(userId, req.params.requestId);
      return ApiResponse.ok(res, result);
    },
  );

  rejectRequest = asyncHandler(
    async (req: WithParams<RequestIdParam>, res: Response) => {
      const userId = this.requireUserId(req);
      const result = await this.friends.rejectRequest(userId, req.params.requestId);
      return ApiResponse.ok(res, result);
    },
  );

  cancelRequest = asyncHandler(
    async (req: WithParams<RequestIdParam>, res: Response) => {
      const userId = this.requireUserId(req);
      const result = await this.friends.cancelRequest(userId, req.params.requestId);
      return ApiResponse.ok(res, result);
    },
  );

  listRequests = asyncHandler(async (req: Request, res: Response) => {
    const userId = this.requireUserId(req);
    const result = await this.friends.listRequests(userId);
    return ApiResponse.ok(res, result);
  });

  removeFriend = asyncHandler(
    async (req: WithParams<FriendUserIdParam>, res: Response) => {
      const userId = this.requireUserId(req);
      await this.friends.removeFriend(userId, req.params.friendUserId);
      return ApiResponse.ok(res, null);
    },
  );

  syncContacts = asyncHandler(async (req: WithBody<SyncContactsBody>, res: Response) => {
    const userId = this.requireUserId(req);
    const result = await this.friends.syncContacts(userId, req.body.phones);
    return ApiResponse.ok(res, result);
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  private requireUserId(req: Request): string {
    if (req.user === undefined) {
      throw ApiError.unauthorized('Auth middleware did not run');
    }
    return req.user.id;
  }
}
