import type { Router } from 'express';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { AuthController } from './controller/auth.controller.js';
import { RefreshTokenRepository } from './repository/refresh-token.repository.js';
import { UserRepository } from './repository/user.repository.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { AuthService } from './service/auth.service.js';
import { MockOtpProvider } from './service/otp/mock-otp.provider.js';
import type { OtpProvider } from './service/otp/otp-provider.js';
import { TokenService } from './service/token.service.js';

/**
 * Build the wired auth module. Centralizes dependency construction so
 * `app.ts` doesn't need to know which repositories / providers are used.
 *
 * To swap the OTP provider in production, replace `MockOtpProvider` with
 * the real implementation and import it here. No other code changes.
 */
export interface AuthModule {
  router: Router;
  service: AuthService;
  tokens: TokenService;
}

export function createAuthModule(overrides: Partial<{ otp: OtpProvider }> = {}): AuthModule {
  const tokens = new TokenService({
    secret: env.JWT_SECRET,
    accessExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  });
  const otp = overrides.otp ?? new MockOtpProvider();
  const service = new AuthService(
    new UserRepository(prisma),
    new RefreshTokenRepository(prisma),
    otp,
    tokens,
  );
  const controller = new AuthController(service);
  const router = createAuthRouter({ controller, tokens });
  return { router, service, tokens };
}

export { AuthService } from './service/auth.service.js';
export { TokenService } from './service/token.service.js';
export type { OtpProvider, OtpStartResult } from './service/otp/otp-provider.js';
export { MockOtpProvider } from './service/otp/mock-otp.provider.js';
export { AuthController } from './controller/auth.controller.js';
export { UserRepository } from './repository/user.repository.js';
export { RefreshTokenRepository } from './repository/refresh-token.repository.js';
export type { IUserRepository, CreateUserInput, UpdateUserInput } from './repository/user.repository.js';
export type {
  IRefreshTokenRepository,
  CreateRefreshTokenInput,
} from './repository/refresh-token.repository.js';
