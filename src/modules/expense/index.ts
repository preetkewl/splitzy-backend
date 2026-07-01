import type { Router } from 'express';
import { prisma } from '../../database/prisma.js';
import type { ActivityService } from '../activity/index.js';
import { UserRepository } from '../auth/repository/user.repository.js';
import type { TokenService } from '../auth/service/token.service.js';
import type { EntitlementMiddleware } from '../entitlement/index.js';
import type { NotificationService } from '../notification/service/notification.service.js';
import { SettlementRepository } from '../settlement/repository/settlement.repository.js';
import type { ISettlementRepository } from '../settlement/repository/settlement.repository.js';
import { TripRepository } from '../trip/repository/trip.repository.js';
import { ExpenseController } from './controller/expense.controller.js';
import { ExpenseRepository } from './repository/expense.repository.js';
import { createExpenseRouters } from './routes/expense.routes.js';
import { ExpenseService } from './service/expense.service.js';

export interface ExpenseModule {
  rootRouter: Router;
  tripScopedRouter: Router;
  service: ExpenseService;
}

/**
 * Build the wired Expense module. The Settlement repository can be
 * injected (the `routes/index.ts` factory shares one with the
 * Settlement module so writes and reads see the same Prisma client),
 * or constructed fresh as a fallback for callers that don't care.
 */
export function createExpenseModule(deps: {
  tokens: TokenService;
  settlements?: ISettlementRepository;
  notifications: NotificationService;
  activity: ActivityService;
  /** Entitlement guards — used to gate the premium simplified-balances view. */
  entitlement: EntitlementMiddleware;
}): ExpenseModule {
  const expenseRepo = new ExpenseRepository(prisma);
  const tripRepo = new TripRepository(prisma);
  const userRepo = new UserRepository(prisma);
  const settlementRepo = deps.settlements ?? new SettlementRepository(prisma);
  const service = new ExpenseService(
    expenseRepo,
    tripRepo,
    userRepo,
    settlementRepo,
    deps.notifications,
    deps.activity,
  );
  const controller = new ExpenseController(service);
  const { rootRouter, tripScopedRouter } = createExpenseRouters({
    controller,
    tokens: deps.tokens,
    entitlement: deps.entitlement,
  });
  return { rootRouter, tripScopedRouter, service };
}

export { BalanceEngine } from './engine/balance-engine.js';
export type {
  ExpenseInput,
  NetBalance,
  ParticipantShare,
  SettlementTransfer,
} from './engine/balance-engine.js';
export type { RawParticipantInput, SplitCalculator, SplitResult } from './engine/split-types.js';
export { SplitCalculatorRegistry, splitRegistry } from './engine/split-registry.js';
export { EqualSplitCalculator } from './engine/calculators/equal.calculator.js';
export { ExactSplitCalculator } from './engine/calculators/exact.calculator.js';
export { PercentSplitCalculator } from './engine/calculators/percent.calculator.js';
export { SharesSplitCalculator } from './engine/calculators/shares.calculator.js';
export { ExpenseService } from './service/expense.service.js';
export { ExpenseController } from './controller/expense.controller.js';
export { ExpenseRepository } from './repository/expense.repository.js';
export type {
  CreateExpenseData,
  ExpenseAggregateRow,
  ExpenseWithRelations,
  IExpenseRepository,
} from './repository/expense.repository.js';
