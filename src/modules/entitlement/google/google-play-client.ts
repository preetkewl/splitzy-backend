import { type androidpublisher_v3, google } from 'googleapis';
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { SubscriptionState } from '../constants.js';
import { GooglePlayConfigError, InvalidPurchaseTokenError, type NormalizedSubscription } from './types.js';

/**
 * Isolates ALL Google Play Developer API contact. Nothing else in the codebase
 * imports `googleapis`. Defined as an interface so the verification flow can be
 * unit-tested against a fake without network or credentials.
 */
export interface GooglePlayClient {
  /** True when a service account + package name are configured. */
  readonly isConfigured: boolean;
  /**
   * Fetch + normalize the authoritative subscription state for a token.
   * @throws InvalidPurchaseTokenError when Google rejects the token (4xx).
   * @throws GooglePlayConfigError when credentials are missing.
   */
  getSubscription(purchaseToken: string): Promise<NormalizedSubscription>;
  /**
   * Acknowledge a subscription purchase. Idempotent on Google's side — acking an
   * already-acknowledged purchase is a no-op there, but we still gate the call
   * on our persisted ack flag to avoid needless requests.
   */
  acknowledgeSubscription(productId: string, purchaseToken: string): Promise<void>;
}

const ANDROIDPUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

// Google's SUBSCRIPTION_STATE_* → our SubscriptionState. REVOKED is intentionally
// absent: it arrives via voided-purchase / RTDN signals, not subscriptionsv2.get.
const STATE_MAP: Record<string, SubscriptionState> = {
  SUBSCRIPTION_STATE_ACTIVE: SubscriptionState.ACTIVE,
  SUBSCRIPTION_STATE_CANCELED: SubscriptionState.CANCELED,
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: SubscriptionState.IN_GRACE_PERIOD,
  SUBSCRIPTION_STATE_ON_HOLD: SubscriptionState.ON_HOLD,
  SUBSCRIPTION_STATE_PAUSED: SubscriptionState.PAUSED,
  SUBSCRIPTION_STATE_EXPIRED: SubscriptionState.EXPIRED,
  SUBSCRIPTION_STATE_PENDING: SubscriptionState.PENDING,
};

interface GaxiosLikeError {
  response?: { status?: number };
  code?: number | string;
}

function httpStatusOf(err: unknown): number | undefined {
  const e = err as GaxiosLikeError;
  if (typeof e?.response?.status === 'number') return e.response.status;
  if (typeof e?.code === 'number') return e.code;
  return undefined;
}

export class AndroidPublisherGooglePlayClient implements GooglePlayClient {
  private readonly packageName: string | undefined;
  private readonly client: androidpublisher_v3.Androidpublisher | null;

  constructor() {
    this.packageName = env.GOOGLE_PLAY_PACKAGE_NAME;
    this.client = this.buildClient();
  }

  get isConfigured(): boolean {
    return this.client !== null && typeof this.packageName === 'string' && this.packageName.length > 0;
  }

  private buildClient(): androidpublisher_v3.Androidpublisher | null {
    const json = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (!json) {
      logger.warn('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON not set — subscription verification disabled');
      return null;
    }
    try {
      const credentials = JSON.parse(json) as Record<string, unknown>;
      // Use the GoogleAuth bundled with googleapis (not the top-level
      // google-auth-library) so the auth instance type matches what the
      // androidpublisher client expects — avoids a dual-version type clash.
      const auth = new google.auth.GoogleAuth({ credentials, scopes: [ANDROIDPUBLISHER_SCOPE] });
      return google.androidpublisher({ version: 'v3', auth });
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Google Play client — verification disabled');
      return null;
    }
  }

  private requireClient(): androidpublisher_v3.Androidpublisher {
    if (!this.client || !this.packageName) {
      throw new GooglePlayConfigError(
        'Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON and GOOGLE_PLAY_PACKAGE_NAME to enable verification',
      );
    }
    return this.client;
  }

  async getSubscription(purchaseToken: string): Promise<NormalizedSubscription> {
    const client = this.requireClient();
    try {
      const res = await client.purchases.subscriptionsv2.get({
        packageName: this.packageName,
        token: purchaseToken,
      });
      return this.normalize(res.data);
    } catch (err) {
      const status = httpStatusOf(err);
      // 400/404/410 → Google does not recognize this token. Treat as invalid
      // (the caller maps to a 4xx and grants nothing). 401/403/5xx are config /
      // transient failures and must propagate as unexpected errors.
      if (status === 400 || status === 404 || status === 410) {
        throw new InvalidPurchaseTokenError();
      }
      throw err;
    }
  }

  async acknowledgeSubscription(productId: string, purchaseToken: string): Promise<void> {
    const client = this.requireClient();
    await client.purchases.subscriptions.acknowledge({
      packageName: this.packageName,
      subscriptionId: productId,
      token: purchaseToken,
      requestBody: {},
    });
  }

  /** Map Google's SubscriptionPurchaseV2 onto our normalized shape. */
  private normalize(data: androidpublisher_v3.Schema$SubscriptionPurchaseV2): NormalizedSubscription {
    const lineItems = data.lineItems ?? [];

    // Choose the line item with the furthest-out expiry as the active plan.
    let productId: string | null = null;
    let expiresAt: Date | null = null;
    let autoRenewing = false;
    for (const li of lineItems) {
      const exp = li.expiryTime ? new Date(li.expiryTime) : null;
      if (exp && (expiresAt === null || exp > expiresAt)) {
        expiresAt = exp;
        productId = li.productId ?? productId;
        autoRenewing = li.autoRenewingPlan?.autoRenewEnabled ?? false;
      } else if (expiresAt === null && li.productId) {
        // No expiry on any item yet — still surface the product id.
        productId = li.productId;
        autoRenewing = li.autoRenewingPlan?.autoRenewEnabled ?? autoRenewing;
      }
    }

    const stateKey = data.subscriptionState ?? '';
    const state = STATE_MAP[stateKey] ?? SubscriptionState.PENDING;

    return {
      productId,
      state,
      expiresAt,
      autoRenewing,
      acknowledged: data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      orderId: data.latestOrderId ?? null,
      purchasedAt: data.startTime ? new Date(data.startTime) : null,
      linkedPurchaseToken: data.linkedPurchaseToken ?? null,
      raw: data as unknown as NormalizedSubscription['raw'],
    };
  }
}
