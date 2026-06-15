import { EntitlementType } from '../constants.js';
import type { Db, EntitlementRepository } from '../repository/entitlement.repository.js';

export interface EntitlementSnapshot {
  premium: boolean;
  /** ISO timestamp of the active premium expiry, or null (none / perpetual). */
  premiumExpiresAt: string | null;
}

/**
 * Authoritative read of a user's entitlement state — the single place anything
 * (middleware, limit checks) asks "is this user premium right now".
 *
 * Reads the derived UserEntitlement rows, NEVER the denormalized User.isPremium
 * cache (which can lag a refund/expiry until the next write). Accepts an
 * optional transaction executor so it can participate in a race-safe
 * enforcement transaction.
 */
export class EntitlementGuardService {
  constructor(private readonly repo: EntitlementRepository) {}

  async isPremium(userId: string, db?: Db): Promise<boolean> {
    const active = await this.repo.findActiveEntitlement(userId, EntitlementType.PREMIUM, new Date(), db);
    return active !== null;
  }

  async resolve(userId: string, db?: Db): Promise<EntitlementSnapshot> {
    const active = await this.repo.findActiveEntitlement(userId, EntitlementType.PREMIUM, new Date(), db);
    return {
      premium: active !== null,
      premiumExpiresAt: active?.expiresAt?.toISOString() ?? null,
    };
  }
}
