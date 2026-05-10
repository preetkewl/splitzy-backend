/**
 * Wire-format types returned by the auth API. Decoupled from the Prisma
 * row shape so adding/renaming columns doesn't break the client.
 */

export interface UserDto {
  id: string;
  phone: string;
  handle: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
  upiId: string | null;
  email: string | null;
  /** True when the user has filled out the profile screen. */
  profileComplete: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Login flow ───────────────────────────────────────────────────────────────

export interface LoginInput {
  phone: string;
}

export interface LoginResponseDto {
  challengeToken: string;
  expiresAt: string;
  /** Only present in non-production for the mock OTP provider. */
  devOtp?: string;
}

// ── Verify flow ──────────────────────────────────────────────────────────────

export interface VerifyInput {
  challengeToken: string;
  otp: string;
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
}
