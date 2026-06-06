import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { ActivityService } from '../service/activity.service.js';
import type { ListActivityQuery } from '../validation/index.js';

export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  /** GET /activity — the current user's reverse-chronological feed. */
  list = asyncHandler(async (req: Request, res: Response) => {
    const userId = this.requireUserId(req);
    // `validateRequest` has already parsed/coerced the query in place.
    const query = req.query as unknown as ListActivityQuery;
    const feed = await this.activity.feed(userId, {
      limit: query.limit,
      cursor: query.cursor,
    });
    return ApiResponse.ok(res, feed);
  });

  private requireUserId(req: Request): string {
    if (req.user === undefined) throw ApiError.unauthorized('Auth middleware did not run');
    return req.user.id;
  }
}
