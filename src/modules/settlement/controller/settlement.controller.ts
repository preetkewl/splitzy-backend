import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { SettlementService } from '../service/settlement.service.js';
import type {
  CreateSettlementBody,
  ListSettlementsQuery,
  TripIdParam,
} from '../validation/index.js';

type WithBody<TBody> = Request<Record<string, string>, unknown, TBody>;
type WithParams<TParams extends Record<string, string>> = Request<TParams>;

export class SettlementController {
  constructor(private readonly settlements: SettlementService) {}

  create = asyncHandler(async (req: WithBody<CreateSettlementBody>, res: Response) => {
    const userId = this.requireUserId(req);
    const settlement = await this.settlements.create(userId, {
      tripId: req.body.tripId,
      fromUserId: req.body.fromUserId,
      toUserId: req.body.toUserId,
      amountMinor: req.body.amountMinor,
      method: req.body.method,
      note: req.body.note ?? null,
      externalRef: req.body.externalRef ?? null,
    });
    return ApiResponse.created(res, settlement);
  });

  listForTrip = asyncHandler(async (req: WithParams<TripIdParam>, res: Response) => {
    const userId = this.requireUserId(req);
    const query = req.query as unknown as ListSettlementsQuery;
    const result = await this.settlements.list(userId, req.params.tripId, {
      page: query.page,
      pageSize: query.pageSize,
    });
    return ApiResponse.ok(res, result.items, {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
    });
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  private requireUserId(req: Request): string {
    if (req.user === undefined) {
      throw ApiError.unauthorized('Auth middleware did not run');
    }
    return req.user.id;
  }
}
