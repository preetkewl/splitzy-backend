import type { TokenType } from '../constants.js';

interface BaseJwtPayload {
  type: TokenType;
  jti: string;
  iat: number;
  exp: number;
}

export interface AccessTokenPayload extends BaseJwtPayload {
  type: 'access';
  sub: string;
}

export interface RefreshTokenPayload extends BaseJwtPayload {
  type: 'refresh';
  sub: string;
}

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export interface AuthenticatedSession {
  userId: string;
  jti: string;
}
