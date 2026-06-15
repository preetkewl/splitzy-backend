import {
  AuditEventType,
  AuditSource,
  EntitlementChangeReason,
  EntitlementSource,
  EntitlementStatus,
  EntitlementType,
  SubscriptionState,
} from '@prisma/client';

/**
 * Monetization constants — the SINGLE backend source of truth for product IDs
 * and entitlement-derivation rules. Mirrors the frontend
 * `billing_products.dart` catalogue so the two can never drift.
 *
 * Phase 2A is foundation only: nothing here verifies against Google or enforces
 * premium. The values exist so the verification/RTDN/enforcement phases plug in
 * without redefining the vocabulary.
 */

/**
 * The one live subscription product. MUST match the Google Play Console SKU and
 * the frontend `kPremiumMonthlyId` exactly (case-sensitive).
 *
 * NOTE: this replaces the stale Splitzy SKUs (`splitzy_weekly`,
 * `splitzy_monthly`) that the legacy verify endpoint used to accept — those
 * never existed in the real catalogue and caused the live client (which sends
 * `settlio_premium_monthly`) to be rejected.
 */
export const SETTLIO_PREMIUM_MONTHLY = 'settlio_premium_monthly';

/** Every product ID the backend recognises. Unknown IDs are never trusted. */
export const KNOWN_PRODUCT_IDS = [SETTLIO_PREMIUM_MONTHLY] as const;

export type KnownProductId = (typeof KNOWN_PRODUCT_IDS)[number];

export function isKnownProductId(value: string): value is KnownProductId {
  return (KNOWN_PRODUCT_IDS as readonly string[]).includes(value);
}

/**
 * Which product grants which abstract entitlement. Keeps the entitlement model
 * decoupled from SKUs — adding a yearly plan only adds a row here.
 */
export const PRODUCT_ENTITLEMENT: Readonly<Record<KnownProductId, EntitlementType>> = {
  [SETTLIO_PREMIUM_MONTHLY]: EntitlementType.PREMIUM,
};

/**
 * Google subscription states that confer an ACTIVE entitlement while not yet
 * expired. CANCELED stays entitling because the user keeps access until the
 * paid period ends; IN_GRACE_PERIOD keeps access during a billing retry.
 *
 * Used by entitlement derivation in later phases; defined here so the rule has
 * one home. PENDING is intentionally NOT entitling — a locally-recorded,
 * unverified purchase grants nothing.
 */
export const ENTITLING_SUBSCRIPTION_STATES: ReadonlySet<SubscriptionState> = new Set([
  SubscriptionState.ACTIVE,
  SubscriptionState.CANCELED,
  SubscriptionState.IN_GRACE_PERIOD,
]);

// ── Free-tier limits (Phase 3 enforcement) ───────────────────────────────────

/**
 * Quota keys — stable identifiers for the things we meter. Reserved here so the
 * future quota_tracking / reward-unlock work plugs in without renaming. Only
 * ACTIVE_GROUPS is enforced today (via a live count, not the counter table).
 */
export const QUOTA_KEYS = {
  ACTIVE_GROUPS: 'active_groups',
} as const;

export type QuotaKey = (typeof QUOTA_KEYS)[keyof typeof QUOTA_KEYS];

/**
 * Free users may OWN this many active (non-deleted) groups/trips. Premium users
 * are unlimited. Expense logging is deliberately NOT limited — it is the core
 * retention loop.
 *
 * ⚠️ The Flutter client currently uses kFreeGroupLimit = 3; the backend is now
 * authoritative at 2 per the Phase-3 product rules. The frontend must be aligned
 * in a later phase — until then the backend rejects a free user's 3rd group with
 * a structured FREE_GROUP_LIMIT_REACHED error the paywall can consume.
 */
export const FREE_ACTIVE_GROUP_LIMIT = 2;

// Re-export the Prisma-generated enums under a single import surface so callers
// never reach into '@prisma/client' for monetization vocabulary directly.
export {
  AuditEventType,
  AuditSource,
  EntitlementChangeReason,
  EntitlementSource,
  EntitlementStatus,
  EntitlementType,
  SubscriptionState,
};
