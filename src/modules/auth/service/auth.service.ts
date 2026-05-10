import { randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import { ApiError } from '../../../core/api-error.js';
import { ERROR_CODES } from '../../../constants/error-codes.js';
import { HTTP } from '../../../constants/http.js';
import { logger } from '../../../utils/logger.js';
import {
  DEFAULT_AVATAR_COLOR,
  HANDLE_GENERATION_MAX_ATTEMPTS,
} from '../constants.js';
import type {
  AuthSessionDto,
  LoginInput,
  LoginResponseDto,
  RefreshInput,
  RefreshResponseDto,
  UpdateProfileInput,
  UserDto,
  VerifyInput,
} from '../dto/index.js';
import { toUserDto } from '../mapper/user.mapper.js';
import type { IRefreshTokenRepository } from '../repository/refresh-token.repository.js';
import type { IUserRepository } from '../repository/user.repository.js';
import type { OtpProvider } from './otp/otp-provider.js';
import type { TokenService } from './token.service.js';

export interface AuthServiceContext {
  /** Optional request metadata for refresh-token bookkeeping. */
  userAgent?: string | null;
  ipAddress?: string | null;
}

export class AuthService {
  constructor(
    private readonly users: IUserRepository,
    private readonly refreshTokens: IRefreshTokenRepository,
    private readonly otp: OtpProvider,
    private readonly tokens: TokenService,
  ) {}

  // ── login ─────────────────────────────────────────────────────────────────

  async login(input: LoginInput): Promise<LoginResponseDto> {
    const { challengeId, devOtp } = await this.otp.start(input.phone);
    const { token, expiresAt } = this.tokens.signChallengeToken({
      phone: input.phone,
      challengeId,
    });
    logger.info(
      { phone: maskPhone(input.phone), provider: this.otp.name },
      'otp challenge issued',
    );
    const result: LoginResponseDto = {
      challengeToken: token,
      expiresAt: expiresAt.toISOString(),
    };
    if (devOtp !== undefined) result.devOtp = devOtp;
    return result;
  }

  // ── verify ────────────────────────────────────────────────────────────────

  async verify(input: VerifyInput, ctx: AuthServiceContext = {}): Promise<AuthSessionDto> {
    const challenge = this.tokens.verifyChallengeToken(input.challengeToken);
    const ok = await this.otp.verify(challenge.challengeId, challenge.phone, input.otp);
    if (!ok) {
      throw new ApiError(
        HTTP.UNAUTHORIZED,
        ERROR_CODES.INVALID_CREDENTIALS,
        'Invalid OTP',
      );
    }
    const user = await this.findOrCreateUser(challenge.phone);
    const session = await this.issueSession(user, ctx);
    return session;
  }

  // ── refresh ───────────────────────────────────────────────────────────────

  async refresh(input: RefreshInput, ctx: AuthServiceContext = {}): Promise<RefreshResponseDto> {
    // Defense in depth: verify the JWT signature first, then check the
    // hash exists in DB and isn't revoked/expired.
    const decoded = this.tokens.verifyRefreshToken(input.refreshToken);
    const tokenHash = this.tokens.hashRefreshToken(input.refreshToken);
    const stored = await this.refreshTokens.findActiveByHash(tokenHash);
    if (stored === null || stored.userId !== decoded.sub) {
      throw new ApiError(
        HTTP.UNAUTHORIZED,
        ERROR_CODES.INVALID_TOKEN,
        'Refresh token not recognized',
      );
    }
    const user = await this.users.findById(decoded.sub);
    if (user === null) {
      throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.UNAUTHORIZED, 'User no longer exists');
    }

    // Rotate: revoke the old, issue a new pair.
    await this.refreshTokens.revokeById(stored.id);
    const pair = this.tokens.issuePair(user.id);
    await this.refreshTokens.create({
      userId: user.id,
      tokenHash: this.tokens.hashRefreshToken(pair.refreshToken),
      expiresAt: pair.refreshTokenExpiresAt,
      userAgent: ctx.userAgent ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });

    return {
      accessToken: pair.accessToken,
      accessTokenExpiresAt: pair.accessTokenExpiresAt.toISOString(),
      refreshToken: pair.refreshToken,
      refreshTokenExpiresAt: pair.refreshTokenExpiresAt.toISOString(),
    };
  }

  // ── logout ────────────────────────────────────────────────────────────────

  async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken === undefined || refreshToken.length === 0) return;
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);
    await this.refreshTokens.revokeByHash(tokenHash);
  }

  // ── me ────────────────────────────────────────────────────────────────────

  async me(userId: string): Promise<UserDto> {
    const user = await this.users.findById(userId);
    if (user === null) {
      throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.UNAUTHORIZED, 'User not found');
    }
    return toUserDto(user);
  }

  // ── profile ───────────────────────────────────────────────────────────────

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<UserDto> {
    if (input.handle !== undefined) {
      const taken = await this.users.findByHandle(input.handle);
      if (taken !== null && taken.id !== userId) {
        throw new ApiError(
          HTTP.CONFLICT,
          ERROR_CODES.HANDLE_TAKEN,
          'Handle is already taken',
        );
      }
    }

    const update: UpdateProfileInput = {};
    if (input.name !== undefined) update.name = input.name.trim();
    if (input.handle !== undefined) update.handle = input.handle;
    if (input.avatarColor !== undefined) update.avatarColor = input.avatarColor;
    if (input.upiId !== undefined) update.upiId = input.upiId === '' ? null : input.upiId;
    if (input.avatarUrl !== undefined) update.avatarUrl = input.avatarUrl;

    const updated = await this.users.update(userId, update);
    return toUserDto(updated);
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  private async findOrCreateUser(phone: string): Promise<User> {
    const existing = await this.users.findByPhone(phone);
    if (existing !== null) return existing;
    const handle = await this.generateUniqueHandle();
    const created = await this.users.create({
      phone,
      handle,
      name: '',
      avatarColor: DEFAULT_AVATAR_COLOR,
    });
    logger.info({ userId: created.id, phone: maskPhone(phone) }, 'user created');
    return created;
  }

  private async generateUniqueHandle(): Promise<string> {
    for (let i = 0; i < HANDLE_GENERATION_MAX_ATTEMPTS; i += 1) {
      const candidate = `user_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const taken = await this.users.findByHandle(candidate);
      if (taken === null) return candidate;
    }
    throw ApiError.internal('Could not allocate a unique handle');
  }

  private async issueSession(user: User, ctx: AuthServiceContext): Promise<AuthSessionDto> {
    const pair = this.tokens.issuePair(user.id);
    await this.refreshTokens.create({
      userId: user.id,
      tokenHash: this.tokens.hashRefreshToken(pair.refreshToken),
      expiresAt: pair.refreshTokenExpiresAt,
      userAgent: ctx.userAgent ?? null,
      ipAddress: ctx.ipAddress ?? null,
    });
    return {
      user: toUserDto(user),
      accessToken: pair.accessToken,
      accessTokenExpiresAt: pair.accessTokenExpiresAt.toISOString(),
      refreshToken: pair.refreshToken,
      refreshTokenExpiresAt: pair.refreshTokenExpiresAt.toISOString(),
    };
  }
}

function maskPhone(phone: string): string {
  if (phone.length < 6) return '***';
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}
