import type { Request, Response } from 'express';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import { healthService, type HealthLiveness, type HealthReadiness } from '../service/health.service.js';

class HealthController {
  /** Liveness probe — process is up. No dependencies checked. */
  liveness = asyncHandler(async (_req: Request, res: Response<unknown>) => {
    const status: HealthLiveness = await healthService.getLiveness();
    return ApiResponse.ok(res, status);
  });

  /** Readiness probe — dependencies (DB) are reachable. */
  readiness = asyncHandler(async (_req: Request, res: Response<unknown>) => {
    const status: HealthReadiness = await healthService.getReadiness();
    return ApiResponse.ok(res, status);
  });
}

export const healthController = new HealthController();
