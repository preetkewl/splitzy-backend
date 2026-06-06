import type { Request, Response } from 'express';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { DashboardService } from '../service/dashboard.service.js';

export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** GET /me/dashboard — app-bootstrap snapshot for the current user. */
  get = asyncHandler(async (req: Request, res: Response) => {
    const userId = this.requireUserId(req);
    const data = await this.dashboard.getDashboard(userId);
    return ApiResponse.ok(res, data);
  });

  private requireUserId(req: Request): string {
    if (req.user === undefined) throw ApiError.unauthorized('Auth middleware did not run');
    return req.user.id;
  }
}
