import { Router } from 'express';
import { requireAuth, validateRequest } from '../../../middlewares/index.js';
import type { TokenService } from '../../auth/service/token.service.js';
import type { ExpenseController } from '../controller/expense.controller.js';
import {
  createExpenseBodySchema,
  expenseIdParamSchema,
  listExpensesQuerySchema,
  tripIdParamSchema,
} from '../validation/index.js';

export interface ExpenseRouterDeps {
  controller: ExpenseController;
  tokens: TokenService;
}

export interface ExpenseRouters {
  /** Mounted at `/expenses`. POST create + DELETE :expenseId. */
  rootRouter: Router;
  /** Mounted at `/trips`. GET /:tripId/expenses + GET /:tripId/balances. */
  tripScopedRouter: Router;
}

export function createExpenseRouters(deps: ExpenseRouterDeps): ExpenseRouters {
  const auth = requireAuth(deps.tokens);

  const rootRouter = Router();
  rootRouter.use(auth);
  rootRouter.post(
    '/',
    validateRequest({ body: createExpenseBodySchema }),
    deps.controller.create,
  );
  rootRouter.delete(
    '/:expenseId',
    validateRequest({ params: expenseIdParamSchema }),
    deps.controller.remove,
  );

  const tripScopedRouter = Router();
  tripScopedRouter.use(auth);
  tripScopedRouter.get(
    '/:tripId/expenses',
    validateRequest({ params: tripIdParamSchema, query: listExpensesQuerySchema }),
    deps.controller.listForTrip,
  );
  tripScopedRouter.get(
    '/:tripId/balances',
    validateRequest({ params: tripIdParamSchema }),
    deps.controller.balancesForTrip,
  );

  return { rootRouter, tripScopedRouter };
}
