import { Router } from 'express';
import { requireAuth, validateRequest } from '../../../middlewares/index.js';
import type { TokenService } from '../../auth/service/token.service.js';
import type { NotificationController } from '../controller/notification.controller.js';
import { registerTokenBodySchema, removeTokenBodySchema } from '../validation/index.js';

export function createNotificationRouter(deps: {
  controller: NotificationController;
  tokens: TokenService;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.tokens);

  router.post(
    '/token',
    auth,
    validateRequest({ body: registerTokenBodySchema }),
    deps.controller.registerToken,
  );

  router.delete(
    '/token',
    auth,
    validateRequest({ body: removeTokenBodySchema }),
    deps.controller.removeToken,
  );

  return router;
}
