import { Router } from 'express';
import { requireAuth } from '../../../middlewares/index.js';
import type { TokenService } from '../../auth/service/token.service.js';
import type { DashboardController } from '../controller/dashboard.controller.js';

/// Mounted at `/me`. Reserved for future per-user bootstrap routes.
export function createDashboardRouter(deps: {
  controller: DashboardController;
  tokens: TokenService;
}): Router {
  const router = Router();
  router.get('/dashboard', requireAuth(deps.tokens), deps.controller.get);
  return router;
}
