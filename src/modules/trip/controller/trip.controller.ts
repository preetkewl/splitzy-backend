import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { TripService } from '../service/trip.service.js';
import type {
  AddMembersBody,
  CreateTripBody,
  ListTripsQuery,
  TripIdParam,
  TripMemberParam,
  UpdateTripBody,
} from '../validation/index.js';

type WithBody<TBody> = Request<Record<string, string>, unknown, TBody>;
type WithParams<TParams extends Record<string, string>> = Request<TParams>;
type WithParamsAndBody<TParams extends Record<string, string>, TBody> = Request<
  TParams,
  unknown,
  TBody
>;

/**
 * Thin HTTP layer for the Trip module. Validation lives in middleware,
 * authorization lives in the service — this class just wires the two.
 */
export class TripController {
  constructor(private readonly trips: TripService) {}

  create = asyncHandler(async (req: WithBody<CreateTripBody>, res: Response) => {
    const userId = this.requireUserId(req);
    const trip = await this.trips.create(userId, {
      name: req.body.name,
      emoji: req.body.emoji,
      coverColor: req.body.coverColor,
      description: req.body.description ?? null,
      memberIds: req.body.memberIds,
    });
    return ApiResponse.created(res, trip);
  });

  list = asyncHandler(async (req: Request, res: Response) => {
    const userId = this.requireUserId(req);
    // validateRequest middleware coerces page/pageSize to numbers — re-narrow.
    const query = req.query as unknown as ListTripsQuery;
    const result = await this.trips.list(userId, {
      page: query.page,
      pageSize: query.pageSize,
    });
    return ApiResponse.ok(res, result.items, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    });
  });

  detail = asyncHandler(async (req: WithParams<TripIdParam>, res: Response) => {
    const userId = this.requireUserId(req);
    const trip = await this.trips.detail(userId, req.params.tripId);
    return ApiResponse.ok(res, trip);
  });

  update = asyncHandler(
    async (req: WithParamsAndBody<TripIdParam, UpdateTripBody>, res: Response) => {
      const userId = this.requireUserId(req);
      const trip = await this.trips.update(userId, req.params.tripId, {
        name: req.body.name,
        emoji: req.body.emoji,
        coverColor: req.body.coverColor,
        description: req.body.description,
      });
      return ApiResponse.ok(res, trip);
    },
  );

  remove = asyncHandler(async (req: WithParams<TripIdParam>, res: Response) => {
    const userId = this.requireUserId(req);
    await this.trips.softDelete(userId, req.params.tripId);
    return ApiResponse.noContent(res);
  });

  addMembers = asyncHandler(
    async (req: WithParamsAndBody<TripIdParam, AddMembersBody>, res: Response) => {
      const userId = this.requireUserId(req);
      const members = await this.trips.addMembers(userId, req.params.tripId, {
        userIds: req.body.userIds,
      });
      return ApiResponse.ok(res, members);
    },
  );

  removeMember = asyncHandler(async (req: WithParams<TripMemberParam>, res: Response) => {
    const userId = this.requireUserId(req);
    await this.trips.removeMember(userId, req.params.tripId, req.params.memberId);
    return ApiResponse.noContent(res);
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  private requireUserId(req: Request): string {
    if (req.user === undefined) {
      throw ApiError.unauthorized('Auth middleware did not run');
    }
    return req.user.id;
  }
}
