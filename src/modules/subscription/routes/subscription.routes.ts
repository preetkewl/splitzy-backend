import { Router } from 'express';
import { requireAuth, validateRequest } from '../../../middlewares/index.js';
import type { TokenService } from '../../auth/service/token.service.js';
import type { SubscriptionController } from '../controller/subscription.controller.js';
import { verifySubscriptionBodySchema } from '../validation/index.js';

export function createSubscriptionRouter(deps: {
  controller: SubscriptionController;
  tokens: TokenService;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.tokens);

  router.post(
    '/verify',
    auth,
    validateRequest({ body: verifySubscriptionBodySchema }),
    deps.controller.verify,
  );

  return router;
}
