import type { SubscriptionRepository } from '../repository/subscription.repository.js';
import type { SubscriptionStatusDto, VerifySubscriptionInput } from '../dto/index.js';

// Weekly = 7 days, Monthly = 30 days. These are generous — a real
// implementation would verify expiry from the Google Play Developer API.
const EXPIRY_DAYS: Record<string, number> = {
  splitzy_weekly: 7,
  splitzy_monthly: 30,
};

export class SubscriptionService {
  constructor(private readonly repo: SubscriptionRepository) {}

  async verify(userId: string, input: VerifySubscriptionInput): Promise<SubscriptionStatusDto> {
    const days = EXPIRY_DAYS[input.productId] ?? 30;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    const user = await this.repo.updateSubscription(userId, {
      isPremium: true,
      subscriptionToken: input.purchaseToken,
      subscriptionProductId: input.productId,
      subscriptionExpiresAt: expiresAt,
    });

    return {
      isPremium: user.isPremium,
      productId: user.subscriptionProductId,
      expiresAt: user.subscriptionExpiresAt?.toISOString() ?? null,
    };
  }
}
