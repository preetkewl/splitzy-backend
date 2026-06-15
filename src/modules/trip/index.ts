import type { Router } from 'express';
import { prisma } from '../../database/prisma.js';
import type { ActivityService } from '../activity/index.js';
import type { TokenService } from '../auth/service/token.service.js';
import type { LimitEvaluationService } from '../entitlement/service/limit-evaluation.service.js';
import { ExpenseRepository } from '../expense/repository/expense.repository.js';
import { SettlementRepository } from '../settlement/repository/settlement.repository.js';
import { TripController } from './controller/trip.controller.js';
import { TripRepository } from './repository/trip.repository.js';
import { createTripRouter } from './routes/trip.routes.js';
import { TripService } from './service/trip.service.js';

export interface TripModule {
  router: Router;
  service: TripService;
}

export function createTripModule(deps: {
  tokens: TokenService;
  activity: ActivityService;
  limits: LimitEvaluationService;
}): TripModule {
  const repository = new TripRepository(prisma);
  const expenseRepo = new ExpenseRepository(prisma);
  const settlementRepo = new SettlementRepository(prisma);
  const service = new TripService(repository, expenseRepo, settlementRepo, deps.activity, deps.limits);
  const controller = new TripController(service);
  const router = createTripRouter({ controller, tokens: deps.tokens });
  return { router, service };
}

export { TripService } from './service/trip.service.js';
export { TripController } from './controller/trip.controller.js';
export { TripRepository } from './repository/trip.repository.js';
export type {
  CreateTripData,
  ITripRepository,
  TripDetailRow,
  TripListRow,
  TripMemberWithUser,
  UpdateTripData,
} from './repository/trip.repository.js';
