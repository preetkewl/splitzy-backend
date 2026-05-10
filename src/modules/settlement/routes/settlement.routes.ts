import { Router } from 'express';
import { requireAuth, validateRequest } from '../../../middlewares/index.js';
import type { TokenService } from '../../auth/service/token.service.js';
import type { SettlementController } from '../controller/settlement.controller.js';
import {
  createSettlementBodySchema,
  listSettlementsQuerySchema,
  tripIdParamSchema,
} from '../validation/index.js';

export interface SettlementRouterDeps {
  controller: SettlementController;
  tokens: TokenService;
}

export interface SettlementRouters {
  /** Mounted at `/settlements`. POST create. */
  rootRouter: Router;
  /** Mounted at `/trips`. GET /:tripId/settlements. */
  tripScopedRouter: Router;
}

export function createSettlementRouters(deps: SettlementRouterDeps): SettlementRouters {
  const auth = requireAuth(deps.tokens);

  const rootRouter = Router();
  rootRouter.use(auth);
  rootRouter.post(
    '/',
    validateRequest({ body: createSettlementBodySchema }),
    deps.controller.create,
  );

  const tripScopedRouter = Router();
  tripScopedRouter.use(auth);
  tripScopedRouter.get(
    '/:tripId/settlements',
    validateRequest({ params: tripIdParamSchema, query: listSettlementsQuerySchema }),
    deps.controller.listForTrip,
  );

  return { rootRouter, tripScopedRouter };
}
