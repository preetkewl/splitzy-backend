import { Router } from 'express';
import { requireAuth, validateRequest } from '../../../middlewares/index.js';
import type { TokenService } from '../../auth/service/token.service.js';
import { correlationMiddleware } from '../../entitlement/observability/index.js';
import type { SubscriptionController } from '../controller/subscription.controller.js';
import type { RtdnController } from '../rtdn/rtdn.controller.js';
import { verifyRtdnToken } from '../rtdn/rtdn-auth.middleware.js';
import { rtdnPushBodySchema, verifySubscriptionBodySchema } from '../validation/index.js';

export function createSubscriptionRouter(deps: {
  controller: SubscriptionController;
  rtdnController: RtdnController;
  tokens: TokenService;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.tokens);

  // Establishes the ambient correlation id (from X-Request-Id) for the whole
  // subscription surface so every downstream billing log carries it.
  router.use(correlationMiddleware);

  router.post(
    '/verify',
    auth,
    validateRequest({ body: verifySubscriptionBodySchema }),
    deps.controller.verify,
  );

  // RTDN webhook: NO user auth (Google calls it) — guarded by a shared-secret
  // token instead. Idempotent + retry-safe in the service layer.
  router.post(
    '/rtdn',
    verifyRtdnToken,
    validateRequest({ body: rtdnPushBodySchema }),
    deps.rtdnController.handle,
  );

  return router;
}
