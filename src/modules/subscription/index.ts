import type { Router } from 'express';
import { prisma } from '../../database/prisma.js';
import type { TokenService } from '../auth/service/token.service.js';
import { SubscriptionController } from './controller/subscription.controller.js';
import { SubscriptionRepository } from './repository/subscription.repository.js';
import { createSubscriptionRouter } from './routes/subscription.routes.js';
import { SubscriptionService } from './service/subscription.service.js';

export interface SubscriptionModule {
  router: Router;
}

export function createSubscriptionModule(deps: { tokens: TokenService }): SubscriptionModule {
  const repository = new SubscriptionRepository(prisma);
  const service = new SubscriptionService(repository);
  const controller = new SubscriptionController(service);
  const router = createSubscriptionRouter({ controller, tokens: deps.tokens });
  return { router };
}
