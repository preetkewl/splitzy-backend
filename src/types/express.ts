/**
 * Augmentations for Express's Request type.
 *
 * Future modules attach decoded JWT info, request ids, etc. on `req`.
 * Keep additions narrow and fully typed — never `any`.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by auth middleware (Step 2). */
      user?: {
        id: string;
        email?: string;
      };
      /**
       * Per-request correlation id. Set by `requestId` middleware in
       * production; absent in test harnesses. Echoed on the response
       * `X-Request-Id` header and threaded through every log line.
       */
      requestId?: string;
      /**
       * Resolved entitlement snapshot, attached by the entitlement-resolver /
       * optionalPremium middleware. Authoritative (derived from
       * UserEntitlement, never the stale User.isPremium cache).
       */
      entitlement?: {
        premium: boolean;
        premiumExpiresAt: string | null;
      };
    }
  }
}

export {};
