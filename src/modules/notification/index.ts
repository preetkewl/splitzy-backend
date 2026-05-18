import type { Router } from 'express';
import { prisma } from '../../database/prisma.js';
import type { TokenService } from '../auth/service/token.service.js';
import { NotificationController } from './controller/notification.controller.js';
import { DeviceTokenRepository } from './repository/device-token.repository.js';
import { createNotificationRouter } from './routes/notification.routes.js';
import { NotificationService } from './service/notification.service.js';

export interface NotificationModule {
  router: Router;
  service: NotificationService;
}

export function createNotificationModule(deps: { tokens: TokenService }): NotificationModule {
  const tokenRepo = new DeviceTokenRepository(prisma);
  const service = new NotificationService(tokenRepo);
  const controller = new NotificationController(service);
  const router = createNotificationRouter({ controller, tokens: deps.tokens });
  return { router, service };
}

export { NotificationService } from './service/notification.service.js';
export type { NotificationPayload, NotificationType } from './service/notification.service.js';
export { DeviceTokenRepository } from './repository/device-token.repository.js';
export type { IDeviceTokenRepository } from './repository/device-token.repository.js';
