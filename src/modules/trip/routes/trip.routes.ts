import { Router } from 'express';
import { requireAuth, validateRequest } from '../../../middlewares/index.js';
import type { TokenService } from '../../auth/service/token.service.js';
import type { TripController } from '../controller/trip.controller.js';
import {
  addMembersBodySchema,
  createTripBodySchema,
  listTripsQuerySchema,
  tripIdParamSchema,
  tripMemberParamSchema,
  updateTripBodySchema,
} from '../validation/index.js';

export interface TripRouterDeps {
  controller: TripController;
  tokens: TokenService;
}

export function createTripRouter(deps: TripRouterDeps): Router {
  const router = Router();
  const auth = requireAuth(deps.tokens);

  // Every trip endpoint requires authentication.
  router.use(auth);

  router.post('/', validateRequest({ body: createTripBodySchema }), deps.controller.create);
  router.get('/', validateRequest({ query: listTripsQuerySchema }), deps.controller.list);

  router.get(
    '/:tripId',
    validateRequest({ params: tripIdParamSchema }),
    deps.controller.detail,
  );

  router.patch(
    '/:tripId',
    validateRequest({ params: tripIdParamSchema, body: updateTripBodySchema }),
    deps.controller.update,
  );

  router.delete(
    '/:tripId',
    validateRequest({ params: tripIdParamSchema }),
    deps.controller.remove,
  );

  router.post(
    '/:tripId/members',
    validateRequest({ params: tripIdParamSchema, body: addMembersBodySchema }),
    deps.controller.addMembers,
  );

  router.delete(
    '/:tripId/members/:memberId',
    validateRequest({ params: tripMemberParamSchema }),
    deps.controller.removeMember,
  );

  return router;
}
