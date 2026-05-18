import type { Router } from 'express';
import { prisma } from '../../database/prisma.js';
import { UserRepository } from '../auth/repository/user.repository.js';
import type { TokenService } from '../auth/service/token.service.js';
import type { NotificationService } from '../notification/service/notification.service.js';
import { FriendController } from './controller/friend.controller.js';
import { FriendRepository } from './repository/friend.repository.js';
import { createFriendRouter } from './routes/friend.routes.js';
import { FriendService } from './service/friend.service.js';

export interface FriendModule {
  router: Router;
  service: FriendService;
}

export function createFriendModule(deps: {
  tokens: TokenService;
  notifications: NotificationService;
}): FriendModule {
  const friendRepo = new FriendRepository(prisma);
  const userRepo = new UserRepository(prisma);
  const service = new FriendService(friendRepo, userRepo, deps.notifications);
  const controller = new FriendController(service);
  const router = createFriendRouter({ controller, tokens: deps.tokens });
  return { router, service };
}

export { FriendService } from './service/friend.service.js';
export { FriendController } from './controller/friend.controller.js';
export { FriendRepository } from './repository/friend.repository.js';
export type {
  FriendRequestWithUsers,
  FriendshipWithUsers,
  IFriendRepository,
  SearchFilter,
} from './repository/friend.repository.js';
