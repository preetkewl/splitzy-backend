import type { PrismaClient, User } from '@prisma/client';

export interface UpdateSubscriptionInput {
  isPremium: boolean;
  subscriptionToken: string;
  subscriptionProductId: string;
  subscriptionExpiresAt: Date;
}

export class SubscriptionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  updateSubscription(userId: string, input: UpdateSubscriptionInput): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: input,
    });
  }

  revokeSubscription(userId: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        isPremium: false,
        subscriptionToken: null,
        subscriptionProductId: null,
        subscriptionExpiresAt: null,
      },
    });
  }
}
