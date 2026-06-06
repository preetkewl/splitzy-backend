import { Router } from 'express';
import { requireAuth, validateRequest } from '../../../middlewares/index.js';
import type { TokenService } from '../../auth/service/token.service.js';
import type { ActivityController } from '../controller/activity.controller.js';
import { listActivityQuerySchema } from '../validation/index.js';

export function createActivityRouter(deps: {
  controller: ActivityController;
  tokens: TokenService;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.tokens);

  router.get(
    '/',
    auth,
    validateRequest({ query: listActivityQuerySchema }),
    deps.controller.list,
  );

  return router;
}
