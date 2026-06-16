import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { ApiError } from '../../../core/api-error.js';
import { ApiResponse } from '../../../core/api-response.js';
import { asyncHandler } from '../../../core/async-handler.js';
import type { RewardService } from '../service/reward.service.js';

/**
 * HTTP surface for reward unlocks. Today: the rewarded-ad "+1 group slot" grant.
 *
 * Trust model: we trust the client's `onUserEarnedReward` callback (the request
 * reaching this handler), matching the prior device-local perk. The grant is
 * idempotent and capped server-side, so a replayed/forged call can never stack
 * beyond the cap. AdMob server-side verification (SSV) is the future hardening.
 */
export class RewardController {
  constructor(private readonly rewards: RewardService) {}

  private requireUserId(req: Request): string {
    if (req.user === undefined) throw ApiError.unauthorized('Auth middleware did not run');
    return req.user.id;
  }

  grantGroupSlot = asyncHandler(async (req: Request, res: Response) => {
    const userId = this.requireUserId(req);
    // Capture lightweight ad provenance for audit; never trusted for logic.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sourceEvent: Prisma.InputJsonValue = {
      source: 'rewarded_ad',
      at: new Date().toISOString(),
      ...(typeof body.adUnitId === 'string' ? { adUnitId: body.adUnitId } : {}),
      ...(typeof body.rewardType === 'string' ? { rewardType: body.rewardType } : {}),
    };
    const result = await this.rewards.grantExtraGroupSlot(userId, sourceEvent);
    return ApiResponse.ok(res, result);
  });
}
