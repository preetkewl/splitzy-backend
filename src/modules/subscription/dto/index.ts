export interface SubscriptionStatusDto {
  isPremium: boolean;
  productId: string | null;
  expiresAt: string | null;
}
