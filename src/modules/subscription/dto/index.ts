export interface VerifySubscriptionInput {
  purchaseToken: string;
  productId: string;
}

export interface SubscriptionStatusDto {
  isPremium: boolean;
  productId: string | null;
  expiresAt: string | null;
}
