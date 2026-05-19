import type { Router } from 'express';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { AuthController } from './controller/auth.controller.js';
import { RefreshTokenRepository } from './repository/refresh-token.repository.js';
import { UserRepository } from './repository/user.repository.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { AuthService } from './service/auth.service.js';
import { TokenService } from './service/token.service.js';

export interface AuthModule {
  router: Router;
  service: AuthService;
  tokens: TokenService;
}

export function createAuthModule(): AuthModule {
  const tokens = new TokenService({
    secret: env.JWT_SECRET,
    accessExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  });
  const service = new AuthService(
    new UserRepository(prisma),
    new RefreshTokenRepository(prisma),
    tokens,
  );
  const controller = new AuthController(service);
  const router = createAuthRouter({ controller, tokens });
  return { router, service, tokens };
}

export { AuthService } from './service/auth.service.js';
export { TokenService } from './service/token.service.js';
export { AuthController } from './controller/auth.controller.js';
export { UserRepository } from './repository/user.repository.js';
export { RefreshTokenRepository } from './repository/refresh-token.repository.js';
export type { IUserRepository, CreateUserInput, UpdateUserInput } from './repository/user.repository.js';
export type {
  IRefreshTokenRepository,
  CreateRefreshTokenInput,
} from './repository/refresh-token.repository.js';
