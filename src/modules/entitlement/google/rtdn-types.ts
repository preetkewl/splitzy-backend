/**
 * Google Play Real-Time Developer Notification (RTDN) payload shapes.
 *
 * RTDN arrives as a Pub/Sub push: the outer envelope carries a base64 `data`
 * blob whose decoded JSON is a {@link DeveloperNotification}. We treat the
 * notification ONLY as a "something changed for this token" signal — the
 * authoritative state is always re-fetched from subscriptionsv2.get.
 */

/** Pub/Sub push envelope (`POST` body). */
export interface PubSubPushBody {
  message: {
    /** base64-encoded DeveloperNotification JSON. */
    data?: string;
    /** Pub/Sub-assigned id — the RTDN idempotency key. */
    messageId?: string;
    message_id?: string;
    publishTime?: string;
  };
  subscription?: string;
}

export interface SubscriptionNotification {
  version?: string;
  notificationType?: number;
  purchaseToken?: string;
  subscriptionId?: string;
}

export interface VoidedPurchaseNotification {
  purchaseToken?: string;
  orderId?: string;
  productType?: number;
  refundType?: number;
}

export interface DeveloperNotification {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: SubscriptionNotification;
  voidedPurchaseNotification?: VoidedPurchaseNotification;
  testNotification?: { version?: string };
  oneTimeProductNotification?: unknown;
}

/**
 * SubscriptionNotificationType integer enum (Google's documented values).
 * We re-fetch Google regardless of type, so these mostly drive routing
 * (revoke vs reconcile) and logging.
 */
export const SUB_NOTIFICATION = {
  RECOVERED: 1,
  RENEWED: 2,
  CANCELED: 3,
  PURCHASED: 4,
  ON_HOLD: 5,
  IN_GRACE_PERIOD: 6,
  RESTARTED: 7,
  PRICE_CHANGE_CONFIRMED: 8,
  DEFERRED: 9,
  PAUSED: 10,
  PAUSE_SCHEDULE_CHANGED: 11,
  REVOKED: 12,
  EXPIRED: 13,
} as const;

export const SUB_NOTIFICATION_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(SUB_NOTIFICATION).map(([k, v]) => [v, k]),
);
