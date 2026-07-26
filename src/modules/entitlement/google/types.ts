import type { Prisma } from '@prisma/client';
import type { SubscriptionState } from '../constants.js';

/**
 * Google's response, normalized to exactly what the entitlement flow needs.
 * EVERYTHING authoritative (product, state, expiry, auto-renew, ack) comes from
 * here — never from the client. `raw` is the untouched Google payload, persisted
 * to `subscription_purchases.latestGoogleState` for forensics/reconciliation.
 */
export interface NormalizedSubscription {
  /** Derived from lineItems[].productId — the authoritative SKU. */
  productId: string | null;
  state: SubscriptionState;
  /** Furthest-out line-item expiry. NULL only if Google omits it. */
  expiresAt: Date | null;
  autoRenewing: boolean;
  /** True iff Google reports ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED. */
  acknowledged: boolean;
  orderId: string | null;
  purchasedAt: Date | null;
  /** Set on upgrade/downgrade/resubscribe — the prior token in the chain. */
  linkedPurchaseToken: string | null;
  raw: Prisma.InputJsonValue;
}

/** Google reports the token does not correspond to a real purchase (4xx). */
export class InvalidPurchaseTokenError extends Error {
  constructor(message = 'Invalid or unknown purchase token') {
    super(message);
    this.name = 'InvalidPurchaseTokenError';
  }
}

/** Service-account / package not configured — verification cannot proceed. */
export class GooglePlayConfigError extends Error {
  constructor(message = 'Google Play verification is not configured') {
    super(message);
    this.name = 'GooglePlayConfigError';
  }
}

/** Google returned a product id we do not recognize — never grant on it. */
export class UnknownProductError extends Error {
  constructor(public readonly productId: string | null) {
    super(`Unrecognized subscription product: ${productId ?? 'null'}`);
    this.name = 'UnknownProductError';
  }
}

/**
 * A purchase token cannot be attributed to any user: it is unknown AND either
 * carries no `linkedPurchaseToken` or the linked predecessor is not on record.
 * Raised when there is no asserted (client) identity to fall back on — i.e. from
 * an RTDN for a brand-new token in a chain we have never seen. The caller treats
 * it as terminal-but-harmless (records "unknown_purchase"); a later client
 * verify or the reconciliation sweep re-derives truth.
 */
export class UnattributableTokenError extends Error {
  constructor(
    public readonly purchaseToken: string,
    public readonly linkedPurchaseToken: string | null,
  ) {
    super('Purchase token cannot be attributed to a user (unknown token, no known linked predecessor)');
    this.name = 'UnattributableTokenError';
  }
}
