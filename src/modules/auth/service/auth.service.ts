import type { User } from '@prisma/client';
import { getFirebaseAuth } from '../../../config/firebase.js';
import { ApiError } from '../../../core/api-error.js';
import { ERROR_CODES } from '../../../constants/error-codes.js';
import { HTTP } from '../../../constants/http.js';
import { logger } from '../../../utils/logger.js';
import {
  DEFAULT_AVATAR_COLOR,
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  HANDLE_PATTERN,
} from '../constants.js';
import type {
  AuthSessionDto,
  GoogleSignInInput,
  HandleCheckDto,
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

    if (input.phone !== undefined && input.phone !== null && input.phone !== '') {
      const taken = await this.users.findByPhone(input.phone);
      if (taken !== null && taken.id !== userId) {
        throw new ApiError(HTTP.CONFLICT, ERROR_CODES.PHONE_TAKEN, 'Phone number is already linked to another account');
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

  // ── Delete account ────────────────────────────────────────────────────────

  async deleteAccount(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (user === null) {
      throw new ApiError(HTTP.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'User not found');
    }

    // Revoke all refresh tokens so no new access tokens can be issued.
    await this.refreshTokens.revokeAllForUser(userId);

    // Anonymize PII in-place. Financial records (expenses, settlements,
    // trip memberships) are preserved — they reference this user's id,
    // which remains valid.
    await this.users.softDelete(userId);

    logger.info({ userId }, 'user account deleted and anonymized');
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

    const handle = await this.generateUniqueHandle(input.name);
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

  // ── Handle availability check ─────────────────────────────────────────────

  async checkHandle(userId: string, handle: string): Promise<HandleCheckDto> {
    const taken = await this.users.findByHandle(handle);
    if (taken === null || taken.id === userId) {
      return { available: true, suggestions: [] };
    }

    const suggestions: string[] = [];
    const shortYear = new Date().getFullYear() % 100;
    const fullYear = new Date().getFullYear();

    const candidates = [
      `${handle}_${shortYear}`,
      `${handle}_${fullYear}`,
      `${handle}_1`,
      `${handle}_2`,
      `${handle}_3`,
    ];

    for (const candidate of candidates) {
      if (
        candidate.length >= HANDLE_MIN_LENGTH &&
        candidate.length <= HANDLE_MAX_LENGTH &&
        HANDLE_PATTERN.test(candidate) &&
        (await this.users.findByHandle(candidate)) === null
      ) {
        suggestions.push(candidate);
        if (suggestions.length >= 3) break;
      }
    }

    for (let i = 4; suggestions.length < 3 && i <= 100; i++) {
      const candidate = `${handle}_${i}`;
      if (candidate.length > HANDLE_MAX_LENGTH || !HANDLE_PATTERN.test(candidate)) break;
      if ((await this.users.findByHandle(candidate)) === null) suggestions.push(candidate);
    }

    return { available: false, suggestions };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private nameParts(name: string): string[] {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  private sanitizeHandle(name: string): string {
    const parts = this.nameParts(name);
    if (parts.length === 0) return 'user';
    const firstName = parts[0]!;
    // Use first name alone when it's distinctive (≥ 6 chars);
    // shorter first names get joined with the rest for uniqueness.
    const base = firstName.length >= 6 ? firstName : parts.join('_');
    return base.slice(0, HANDLE_MAX_LENGTH);
  }

  private async generateUniqueHandle(name: string): Promise<string> {
    const sanitized = this.sanitizeHandle(name);
    const base = sanitized.length >= HANDLE_MIN_LENGTH ? sanitized : 'user';

    if ((await this.users.findByHandle(base)) === null) return base;

    // If base is just the first name (long name), also try firstName_lastName
    const parts = this.nameParts(name);
    if (parts.length > 1 && parts[0]!.length >= 6) {
      const withLast = `${parts[0]!}_${parts[parts.length - 1]!}`.slice(0, HANDLE_MAX_LENGTH);
      if (withLast !== base && withLast.length >= HANDLE_MIN_LENGTH) {
        if ((await this.users.findByHandle(withLast)) === null) return withLast;
      }
    }

    for (let i = 1; i <= 50; i++) {
      const candidate = `${base}_${i}`.slice(0, HANDLE_MAX_LENGTH);
      if ((await this.users.findByHandle(candidate)) === null) return candidate;
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
