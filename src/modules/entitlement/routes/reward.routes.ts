import { Router } from 'express';
import { requireAuth } from '../../../middlewares/index.js';
import type { TokenService } from '../../auth/service/token.service.js';
import type { RewardController } from '../controller/reward.controller.js';

/**
 * Mounted at `/me` (shares the mount with the dashboard router). Exposes the
 * rewarded-ad unlock endpoints.
 */
export function createRewardRouter(deps: {
  controller: RewardController;
  tokens: TokenService;
}): Router {
  const router = Router();
  // POST /me/rewards/group-slot — record one rewarded-ad watch → +1 group slot.
  router.post('/rewards/group-slot', requireAuth(deps.tokens), deps.controller.grantGroupSlot);
  return router;
}
