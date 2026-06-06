import type { Router } from 'express';
import { prisma } from '../../database/prisma.js';
import type { TokenService } from '../auth/service/token.service.js';
import { ExpenseRepository } from '../expense/repository/expense.repository.js';
import { FriendRepository } from '../friend/repository/friend.repository.js';
import { SettlementRepository } from '../settlement/repository/settlement.repository.js';
import { TripRepository } from '../trip/repository/trip.repository.js';
import { DashboardController } from './controller/dashboard.controller.js';
import { createDashboardRouter } from './routes/dashboard.routes.js';
import { DashboardService } from './service/dashboard.service.js';

export interface DashboardModule {
  router: Router;
  service: DashboardService;
}

/**
 * Read-only aggregation module. Constructs its own repositories from the shared
 * Prisma client (no writes, so no need to share repo instances with the write
 * modules).
 */
export function createDashboardModule(deps: { tokens: TokenService }): DashboardModule {
  const service = new DashboardService(
    new TripRepository(prisma),
    new ExpenseRepository(prisma),
    new SettlementRepository(prisma),
    new FriendRepository(prisma),
  );
  const controller = new DashboardController(service);
  const router = createDashboardRouter({ controller, tokens: deps.tokens });
  return { router, service };
}

export { DashboardService } from './service/dashboard.service.js';
