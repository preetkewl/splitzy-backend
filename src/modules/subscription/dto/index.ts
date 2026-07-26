export interface SubscriptionStatusDto {
  isPremium: boolean;
  productId: string | null;
  expiresAt: string | null;
  /**
   * Whether the purchase is acknowledged with Google Play (backend-owned). The
   * client waits for `true` before finalizing the local transaction
   * (`completePurchase`); `false` means the ack is deferred to the sweep.
   */
  acknowledged: boolean;
}
