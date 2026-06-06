import type { Router } from 'express';
import { prisma } from '../../database/prisma.js';
import type { TokenService } from '../auth/service/token.service.js';
import { ActivityController } from './controller/activity.controller.js';
import { PrismaActivityRepository } from './repository/activity.repository.js';
import { createActivityRouter } from './routes/activity.routes.js';
import { ActivityService } from './service/activity.service.js';

export interface ActivityModule {
  router: Router;
  /** Injected into the business modules so they can fire-and-forget record(). */
  service: ActivityService;
}

export function createActivityModule(deps: { tokens: TokenService }): ActivityModule {
  const repository = new PrismaActivityRepository(prisma);
  const service = new ActivityService(repository);
  const controller = new ActivityController(service);
  const router = createActivityRouter({ controller, tokens: deps.tokens });
  return { router, service };
}

export { ActivityService } from './service/activity.service.js';
export { ActivityController } from './controller/activity.controller.js';
export { PrismaActivityRepository } from './repository/activity.repository.js';
export type { ActivityRepository } from './repository/activity.repository.js';
