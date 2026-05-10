import type { Router } from 'express';
import { prisma } from '../../database/prisma.js';
import type { TokenService } from '../auth/service/token.service.js';
import { TripRepository } from '../trip/repository/trip.repository.js';
import { SettlementController } from './controller/settlement.controller.js';
import { SettlementRepository } from './repository/settlement.repository.js';
import { createSettlementRouters } from './routes/settlement.routes.js';
import { SettlementService } from './service/settlement.service.js';

export interface SettlementModule {
  rootRouter: Router;
  tripScopedRouter: Router;
  service: SettlementService;
  repository: SettlementRepository;
}

export function createSettlementModule(deps: { tokens: TokenService }): SettlementModule {
  const repository = new SettlementRepository(prisma);
  const tripRepo = new TripRepository(prisma);
  const service = new SettlementService(repository, tripRepo);
  const controller = new SettlementController(service);
  const { rootRouter, tripScopedRouter } = createSettlementRouters({
    controller,
    tokens: deps.tokens,
  });
  return { rootRouter, tripScopedRouter, service, repository };
}

export { SettlementService } from './service/settlement.service.js';
export { SettlementController } from './controller/settlement.controller.js';
export { SettlementRepository } from './repository/settlement.repository.js';
export type {
  CreateSettlementData,
  ISettlementRepository,
  SettlementForBalance,
} from './repository/settlement.repository.js';
export type { SettlementWithUsers } from './mapper/settlement.mapper.js';
