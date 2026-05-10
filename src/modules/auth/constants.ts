/**
 * Auth-module constants. Keep token-shape and validation constants here so
 * service, validation, and tests share a single source of truth.
 */

export const TOKEN_TYPE = {
  ACCESS: 'access',
  REFRESH: 'refresh',
  CHALLENGE: 'challenge',
} as const;
export type TokenType = (typeof TOKEN_TYPE)[keyof typeof TOKEN_TYPE];

/** OTP length the API accepts. Mock provider always returns "123456". */
export const OTP_LENGTH = 6;

/** Lifetime of the OTP challenge JWT — short by design. */
export const CHALLENGE_TTL_SECONDS = 5 * 60;

// ── Profile constraints (mirrored from the Flutter profile screen) ───────────

export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 64;

/** Lowercase letters, digits, underscore. 3–30 chars. */
export const HANDLE_PATTERN = /^[a-z0-9_]{3,30}$/;
export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 30;

/** E.164 phone format: + followed by country code + subscriber, 7–15 digits total. */
export const PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

/** #RRGGBB hex. */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** UPI VPA loose validator: name@provider. */
export const UPI_PATTERN = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/;

export const HANDLE_GENERATION_MAX_ATTEMPTS = 5;

/** Default fallback color for newly created users; replaced by frontend palette later. */
export const DEFAULT_AVATAR_COLOR = '#1F8A5B';
