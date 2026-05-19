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

export interface UpdateProfileInput {
  name?: string;
  handle?: string;
  avatarColor?: string;
  upiId?: string | null;
  avatarUrl?: string | null;
  phone?: string | null;
}
