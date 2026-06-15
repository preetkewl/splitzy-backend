import { z } from 'zod';

// Verify now trusts ONLY the purchaseToken. `productId` is accepted for
// backward compatibility (older clients send it) but is IGNORED — the
// authoritative product is read from Google, never the client. The stale
// Splitzy SKUs are gone with the fake-verification path.
export const verifySubscriptionBodySchema = z.object({
  purchaseToken: z.string().min(1),
  productId: z.string().optional(),
});

export type VerifySubscriptionBody = z.infer<typeof verifySubscriptionBodySchema>;

// Pub/Sub push envelope for the RTDN webhook. Kept permissive (presence of
// `data`/`messageId` is enforced in the controller so we can return a clear
// 400) — we only assert the outer shape here.
export const rtdnPushBodySchema = z.object({
  message: z.object({
    data: z.string().optional(),
    messageId: z.string().optional(),
    message_id: z.string().optional(),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
});
