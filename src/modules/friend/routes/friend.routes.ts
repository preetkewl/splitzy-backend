import { Router } from 'express';
import { requireAuth, validateRequest } from '../../../middlewares/index.js';
import type { TokenService } from '../../auth/service/token.service.js';
import type { FriendController } from '../controller/friend.controller.js';
import {
  friendUserIdParamSchema,
  listFriendsQuerySchema,
  requestIdParamSchema,
  searchQuerySchema,
  sendRequestBodySchema,
  syncContactsBodySchema,
} from '../validation/index.js';

export interface FriendRouterDeps {
  controller: FriendController;
  tokens: TokenService;
}

/**
 * One router for the whole module: every endpoint is auth-only.
 *
 * Order matters — `/requests` comes before `/request/:requestId/...`
 * because Express resolves routes top-down and `/requests` could
 * otherwise be greedily matched by a static-prefix path.
 */
export function createFriendRouter(deps: FriendRouterDeps): Router {
  const router = Router();
  const auth = requireAuth(deps.tokens);
  router.use(auth);

  router.get('/', validateRequest({ query: listFriendsQuerySchema }), deps.controller.list);
  router.delete(
    '/:friendUserId',
    validateRequest({ params: friendUserIdParamSchema }),
    deps.controller.removeFriend,
  );
  router.get('/search', validateRequest({ query: searchQuerySchema }), deps.controller.search);

  router.get('/requests', deps.controller.listRequests);

  router.post(
    '/request',
    validateRequest({ body: sendRequestBodySchema }),
    deps.controller.sendRequest,
  );
  router.post(
    '/request/:requestId/accept',
    validateRequest({ params: requestIdParamSchema }),
    deps.controller.acceptRequest,
  );
  router.post(
    '/request/:requestId/reject',
    validateRequest({ params: requestIdParamSchema }),
    deps.controller.rejectRequest,
  );
  router.post(
    '/request/:requestId/cancel',
    validateRequest({ params: requestIdParamSchema }),
    deps.controller.cancelRequest,
  );

  router.post(
    '/contacts/sync',
    validateRequest({ body: syncContactsBodySchema }),
    deps.controller.syncContacts,
  );

  return router;
}
