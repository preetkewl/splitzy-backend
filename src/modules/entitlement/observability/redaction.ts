import { createHash } from 'node:crypto';

/**
 * Redaction / hashing helpers for subscription telemetry.
 *
 * Purchase tokens and Google order ids are SENSITIVE (a purchase token is a
 * bearer credential for the Google Play Developer API). They must never appear
 * in logs, metrics, or traces in the clear. Instead we emit a stable, one-way
 * fingerprint so a single purchase can still be correlated end-to-end (verify →
 * RTDN → ack → reconcile) without exposing the secret.
 *
 * The fingerprint is a truncated SHA-256 — non-reversible, collision-safe at this
 * scale, and stable for a given token so grouping "all events for this purchase"
 * works across services and time.
 */

const TOKEN_PREFIX = 'pt_';
const ORDER_PREFIX = 'oid_';
const FINGERPRINT_LEN = 16; // hex chars of the sha-256 digest to keep

function fingerprint(value: string, len: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, len);
}

/**
 * One-way fingerprint of a Google Play purchase token, safe to log. Returns a
 * `pt_`-prefixed 16-hex-char digest. `null`/empty → `null` (nothing to hash).
 * NEVER returns the raw token.
 */
export function hashPurchaseToken(token: string | null | undefined): string | null {
  if (!token) return null;
  return TOKEN_PREFIX + fingerprint(token, FINGERPRINT_LEN);
}

/**
 * One-way fingerprint of a Google order id (e.g. `GPA.1234-5678`), safe to log.
 * `oid_`-prefixed. `null`/empty → `null`.
 */
export function hashOrderId(orderId: string | null | undefined): string | null {
  if (!orderId) return null;
  return ORDER_PREFIX + fingerprint(orderId, 12);
}

/**
 * Whether a subscription carries a `linkedPurchaseToken` — the presence flag is
 * what telemetry records (never the linked token itself), so upgrade / downgrade
 * / resubscribe migrations are observable without leaking the token chain.
 */
export function linkedTokenPresent(linkedPurchaseToken: string | null | undefined): boolean {
  return typeof linkedPurchaseToken === 'string' && linkedPurchaseToken.length > 0;
}
