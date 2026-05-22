import { z } from 'zod';

export const verifySubscriptionBodySchema = z.object({
  purchaseToken: z.string().min(1),
  productId: z.enum(['splitzy_weekly', 'splitzy_monthly']),
});

export type VerifySubscriptionBody = z.infer<typeof verifySubscriptionBodySchema>;
