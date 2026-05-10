import { Router } from 'express';
import { createAuthModule } from '../modules/auth/index.js';
import { createExpenseModule } from '../modules/expense/index.js';
import { createFriendModule } from '../modules/friend/index.js';
import { healthRouter } from '../modules/health/routes/health.routes.js';
import { createSettlementModule } from '../modules/settlement/index.js';
import { createTripModule } from '../modules/trip/index.js';

/**
 * Top-level API router. Each business module mounts its own sub-router
 * here. Keeping this file as the single mount-point keeps the API
 * surface easy to audit.
 */
export function createApiRouter(): Router {
  const router = Router();
  const auth = createAuthModule();
  const trips = createTripModule({ tokens: auth.tokens });
  // Settlements are built first so the Expense module can read from the
  // same repository when computing balances — no double-wiring.
  const settlements = createSettlementModule({ tokens: auth.tokens });
  const expenses = createExpenseModule({
    tokens: auth.tokens,
    settlements: settlements.repository,
  });
  const friends = createFriendModule({ tokens: auth.tokens });

  router.use('/health', healthRouter);
  router.use('/auth', auth.router);
  // Three routers share the `/trips` mount: the trip module owns CRUD,
  // the expense module owns `/expenses` + `/balances`, and the settlement
  // module owns `/settlements`.
  router.use('/trips', trips.router);
  router.use('/trips', expenses.tripScopedRouter);
  router.use('/trips', settlements.tripScopedRouter);
  router.use('/expenses', expenses.rootRouter);
  router.use('/settlements', settlements.rootRouter);
  router.use('/friends', friends.router);

  return router;
}
