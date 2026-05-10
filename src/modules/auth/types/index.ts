import type { TokenType } from '../constants.js';

// ── JWT payloads ─────────────────────────────────────────────────────────────

interface BaseJwtPayload {
  /** Token type — guards against using a refresh token where access is expected. */
  type: TokenType;
  /** Standard JWT id; we store this so we can revoke a single token later. */
  jti: string;
  /** Issued at, seconds since epoch. */
  iat: number;
  /** Expires at, seconds since epoch. */
  exp: number;
}

export interface AccessTokenPayload extends BaseJwtPayload {
  type: 'access';
  /** Subject — userId. */
  sub: string;
}

export interface RefreshTokenPayload extends BaseJwtPayload {
  type: 'refresh';
  sub: string;
}

export interface ChallengeTokenPayload extends BaseJwtPayload {
  type: 'challenge';
  /** Normalized E.164 phone the OTP was issued to. */
  phone: string;
  /** Provider-assigned id used to verify the OTP server-side. */
  challengeId: string;
}

// ── Service input/output types ───────────────────────────────────────────────

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
