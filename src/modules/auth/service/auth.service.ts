import { randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import { getFirebaseAuth } from '../../../config/firebase.js';
import { ApiError } from '../../../core/api-error.js';
import { ERROR_CODES } from '../../../constants/error-codes.js';
import { HTTP } from '../../../constants/http.js';
import { logger } from '../../../utils/logger.js';
import { DEFAULT_AVATAR_COLOR, HANDLE_GENERATION_MAX_ATTEMPTS } from '../constants.js';
import type {
  AuthSessionDto,
  GoogleSignInInput,
  RefreshInput,
  RefreshResponseDto,
  UpdateProfileInput,
  UserDto,
} from '../dto/index.js';
import { toUserDto } from '../mapper/user.mapper.js';
import type { IRefreshTokenRepository } from '../repository/refresh-token.repository.js';
import type { IUserRepository } from '../repository/user.repository.js';
import type { TokenService } from './token.service.js';

export interface AuthServiceContext {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export class AuthService {
  constructor(
    private readonly users: IUserRepository,
    private readonly refreshTokens: IRefreshTokenRepository,
    private readonly tokens: TokenService,
  ) {}

  // ── Google Sign-In ────────────────────────────────────────────────────────

  async googleSignIn(input: GoogleSignInInput, ctx: AuthServiceContext = {}): Promise<AuthSessionDto> {
    let decoded: { uid: string; email?: string; name?: string; picture?: string };
    try {
      decoded = await getFirebaseAuth().verifyIdToken(input.idToken);
    } catch {
      throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.INVALID_TOKEN, 'Invalid or expired Firebase ID token');
    }

    const user = await this.findOrCreateByFirebaseUid({
      firebaseUid: decoded.uid,
      email: decoded.email ?? null,
      name: decoded.name ?? '',
      avatarUrl: decoded.picture ?? null,
    });

    logger.info({ userId: user.id, firebaseUid: decoded.uid }, 'google sign-in');
    return this.issueSession(user, ctx);
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  async refresh(input: RefreshInput, ctx: AuthServiceContext = {}): Promise<RefreshResponseDto> {
    const decoded = this.tokens.verifyRefreshToken(input.refreshToken);
    const tokenHash = this.tokens.hashRefreshToken(input.refreshToken);
    const stored = await this.refreshTokens.findActiveByHash(tokenHash);
    if (stored === null || stored.userId !== decoded.sub) {
      throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.INVALID_TOKEN, 'Refresh token not recognized');
    }
    const user = await this.users.findById(decoded.sub);
    if (user === null) {
      throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.UNAUTHORIZED, 'User no longer exists');
    }

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

  // ── Logout ────────────────────────────────────────────────────────────────

  async logout(refreshToken: string | undefined): Promise<void> {
    if (refreshToken === undefined || refreshToken.length === 0) return;
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);
    await this.refreshTokens.revokeByHash(tokenHash);
  }

  // ── Me ────────────────────────────────────────────────────────────────────

  async me(userId: string): Promise<UserDto> {
    const user = await this.users.findById(userId);
    if (user === null) {
      throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.UNAUTHORIZED, 'User not found');
    }
    return toUserDto(user);
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<UserDto> {
    if (input.handle !== undefined) {
      const taken = await this.users.findByHandle(input.handle);
      if (taken !== null && taken.id !== userId) {
        throw new ApiError(HTTP.CONFLICT, ERROR_CODES.HANDLE_TAKEN, 'Handle is already taken');
      }
    }

    const update: UpdateProfileInput = {};
    if (input.name !== undefined) update.name = input.name.trim();
    if (input.handle !== undefined) update.handle = input.handle;
    if (input.avatarColor !== undefined) update.avatarColor = input.avatarColor;
    if (input.upiId !== undefined) update.upiId = input.upiId === '' ? null : input.upiId;
    if (input.avatarUrl !== undefined) update.avatarUrl = input.avatarUrl;
    if (input.phone !== undefined) update.phone = input.phone;

    const updated = await this.users.update(userId, update);
    return toUserDto(updated);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async findOrCreateByFirebaseUid(input: {
    firebaseUid: string;
    email: string | null;
    name: string;
    avatarUrl: string | null;
  }): Promise<User> {
    const existing = await this.users.findByFirebaseUid(input.firebaseUid);
    if (existing !== null) return existing;

    const handle = await this.generateUniqueHandle();
    const created = await this.users.create({
      firebaseUid: input.firebaseUid,
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl,
      handle,
      avatarColor: DEFAULT_AVATAR_COLOR,
    });
    logger.info({ userId: created.id }, 'user created via Google sign-in');
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
