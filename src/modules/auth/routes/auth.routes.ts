import { Router } from 'express';
import { authRateLimiter, requireAuth, validateRequest } from '../../../middlewares/index.js';
import type { AuthController } from '../controller/auth.controller.js';
import type { TokenService } from '../service/token.service.js';
import {
  loginBodySchema,
  logoutBodySchema,
  refreshBodySchema,
  updateProfileBodySchema,
  verifyBodySchema,
} from '../validation/index.js';

export interface AuthRouterDeps {
  controller: AuthController;
  tokens: TokenService;
}

/**
 * Auth router. Wires validation, rate-limiting, and (where required)
 * the access-token guard to each endpoint.
 */
export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const auth = requireAuth(deps.tokens);

  router.post(
    '/login',
    authRateLimiter,
    validateRequest({ body: loginBodySchema }),
    deps.controller.login,
  );

  router.post(
    '/verify',
    authRateLimiter,
    validateRequest({ body: verifyBodySchema }),
    deps.controller.verify,
  );

  router.post(
    '/refresh',
    authRateLimiter,
    validateRequest({ body: refreshBodySchema }),
    deps.controller.refresh,
  );

  router.post(
    '/logout',
    validateRequest({ body: logoutBodySchema }),
    deps.controller.logout,
  );

  router.get('/me', auth, deps.controller.me);

  router.put(
    '/profile',
    auth,
    validateRequest({ body: updateProfileBodySchema }),
    deps.controller.updateProfile,
  );

  return router;
}
