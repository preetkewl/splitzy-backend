import { Router } from 'express';
import { authRateLimiter, requireAuth, validateRequest } from '../../../middlewares/index.js';
import type { AuthController } from '../controller/auth.controller.js';
import type { TokenService } from '../service/token.service.js';
import {
  googleSignInBodySchema,
  logoutBodySchema,
  refreshBodySchema,
  updateProfileBodySchema,
} from '../validation/index.js';

export interface AuthRouterDeps {
  controller: AuthController;
  tokens: TokenService;
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const auth = requireAuth(deps.tokens);

  router.post(
    '/google',
    authRateLimiter,
    validateRequest({ body: googleSignInBodySchema }),
    deps.controller.googleSignIn,
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
