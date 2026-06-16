export interface UserDto {
  id: string;
  firebaseUid: string | null;
  email: string | null;
  name: string;
  handle: string;
  avatarColor: string;
  avatarUrl: string | null;
  phone: string | null;
  upiId: string | null;
  profileComplete: boolean;
  isPremium: boolean;
  /**
   * Effective max active owned groups (free: 2 + earned reward slots, capped at
   * 3; premium: 10). Populated on /auth/me + login; omitted if the allowance
   * lookup is unavailable, in which case the client falls back to its default.
   */
  groupLimit?: number;
  /** Free tier only: true if the user can unlock one more group via a rewarded ad. */
  groupRewardAvailable?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Google Sign-In flow ──────────────────────────────────────────────────────

export interface GoogleSignInInput {
  idToken: string;
}

export interface AuthSessionDto {
  user: UserDto;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

// ── Refresh flow ─────────────────────────────────────────────────────────────

export interface RefreshInput {
  refreshToken: string;
}

export interface RefreshResponseDto {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

// ── Logout ───────────────────────────────────────────────────────────────────

export interface LogoutInput {
  refreshToken?: string;
}

// ── Profile ──────────────────────────────────────────────────────────────────

export interface HandleCheckDto {
  available: boolean;
  suggestions: string[];
}

export interface UpdateProfileInput {
  name?: string;
  handle?: string;
  avatarColor?: string;
  upiId?: string | null;
  avatarUrl?: string | null;
  phone?: string | null;
}
