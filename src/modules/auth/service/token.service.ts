import { createHash, randomUUID } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { ApiError } from '../../../core/api-error.js';
import { ERROR_CODES } from '../../../constants/error-codes.js';
import { HTTP } from '../../../constants/http.js';
import { TOKEN_TYPE } from '../constants.js';
import type {
  AccessTokenPayload,
  IssuedTokenPair,
  RefreshTokenPayload,
} from '../types/index.js';

export interface TokenServiceOptions {
  secret: string;
  accessExpiresIn: string | number;
  refreshExpiresIn: string | number;
}

export class TokenService {
  constructor(private readonly opts: TokenServiceOptions) {}

  // ── Access tokens ──────────────────────────────────────────────────────────

  signAccessToken(userId: string): { token: string; jti: string; expiresAt: Date } {
    const jti = randomUUID();
    const options: SignOptions = {
      jwtid: jti,
      expiresIn: this.opts.accessExpiresIn as SignOptions['expiresIn'],
    };
    const token = jwt.sign(
      { sub: userId, type: TOKEN_TYPE.ACCESS } satisfies Omit<AccessTokenPayload, 'iat' | 'exp' | 'jti'>,
      this.opts.secret,
      options,
    );
    return { token, jti, expiresAt: this.decodeExpiry(token) };
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    const decoded = this.verify(token);
    if (decoded.type !== TOKEN_TYPE.ACCESS) {
      throw ApiError.unauthorized('Wrong token type');
    }
    return decoded as AccessTokenPayload;
  }

  // ── Refresh tokens ─────────────────────────────────────────────────────────

  signRefreshToken(userId: string): { token: string; jti: string; expiresAt: Date } {
    const jti = randomUUID();
    const options: SignOptions = {
      jwtid: jti,
      expiresIn: this.opts.refreshExpiresIn as SignOptions['expiresIn'],
    };
    const token = jwt.sign(
      { sub: userId, type: TOKEN_TYPE.REFRESH } satisfies Omit<RefreshTokenPayload, 'iat' | 'exp' | 'jti'>,
      this.opts.secret,
      options,
    );
    return { token, jti, expiresAt: this.decodeExpiry(token) };
  }

  verifyRefreshToken(token: string): RefreshTokenPayload {
    const decoded = this.verify(token);
    if (decoded.type !== TOKEN_TYPE.REFRESH) {
      throw ApiError.unauthorized('Wrong token type');
    }
    return decoded as RefreshTokenPayload;
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  issuePair(userId: string): IssuedTokenPair & { accessJti: string; refreshJti: string } {
    const access = this.signAccessToken(userId);
    const refresh = this.signRefreshToken(userId);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      accessJti: access.jti,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
      refreshJti: refresh.jti,
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private verify(token: string): AccessTokenPayload | RefreshTokenPayload {
    try {
      const decoded = jwt.verify(token, this.opts.secret);
      if (typeof decoded === 'string' || decoded === null) {
        throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.INVALID_TOKEN, 'Malformed token');
      }
      const type = (decoded as { type?: unknown }).type;
      const sub = (decoded as { sub?: unknown }).sub;
      const jti = (decoded as { jti?: unknown }).jti;
      const iat = (decoded as { iat?: unknown }).iat;
      const exp = (decoded as { exp?: unknown }).exp;
      if (
        typeof type !== 'string' ||
        typeof sub !== 'string' ||
        typeof jti !== 'string' ||
        typeof iat !== 'number' ||
        typeof exp !== 'number'
      ) {
        throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.INVALID_TOKEN, 'Malformed token claims');
      }
      if (type === TOKEN_TYPE.ACCESS) return { type, sub, jti, iat, exp };
      if (type === TOKEN_TYPE.REFRESH) return { type, sub, jti, iat, exp };
      throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.INVALID_TOKEN, 'Unknown token type');
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof jwt.TokenExpiredError) {
        throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.TOKEN_EXPIRED, 'Token expired');
      }
      if (err instanceof jwt.JsonWebTokenError) {
        throw new ApiError(HTTP.UNAUTHORIZED, ERROR_CODES.INVALID_TOKEN, 'Invalid token');
      }
      throw err;
    }
  }

  private decodeExpiry(token: string): Date {
    const decoded = jwt.decode(token);
    if (decoded === null || typeof decoded !== 'object' || typeof decoded.exp !== 'number') {
      throw new Error('Token missing exp claim');
    }
    return new Date(decoded.exp * 1000);
  }
}
