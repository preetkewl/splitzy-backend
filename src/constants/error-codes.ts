/**
 * Stable, machine-readable error codes returned in API responses.
 * Frontend uses these to render specific error states.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  // Auth-specific
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  HANDLE_TAKEN: 'HANDLE_TAKEN',
  PHONE_TAKEN: 'PHONE_TAKEN',
  PENDING_DUES: 'PENDING_DUES',
  // Monetization / entitlement enforcement (Phase 3)
  PREMIUM_REQUIRED: 'PREMIUM_REQUIRED',
  FREE_GROUP_LIMIT_REACHED: 'FREE_GROUP_LIMIT_REACHED',
  // Premium users have a hard cap too (no upsell beyond it).
  PREMIUM_GROUP_LIMIT_REACHED: 'PREMIUM_GROUP_LIMIT_REACHED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
