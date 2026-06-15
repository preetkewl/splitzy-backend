import type { SubscriptionPurchase } from '@prisma/client';
import { ApiError } from '../../../core/api-error.js';
import { AuditEventType, AuditSource } from '../constants.js';
import type { EntitlementRepository } from '../repository/entitlement.repository.js';

export interface RecordPurchaseParams {
  userId: string;
  purchaseToken: string;
  productId: string;
}

/**
 * Purchase ledger foundation.
 *
 * Owns the `subscription_purchases` table: recording a purchase token and
 * guaranteeing the replay/idempotency invariants. It does NOT talk to Google
 * and grants NO entitlement — that is the verification phase's job. In Phase 2A
 * a recorded purchase sits in PENDING and confers nothing.
 *
 * Two safety invariants enforced here:
 *   1. Idempotency — recording the same token again returns the same row
 *      (the unique constraint + upsert), never a duplicate.
 *   2. Replay / token-sharing protection — a token already bound to one user
 *      cannot be claimed by a different user (would be a free-premium exploit
 *      once verification lands). Cross-user reuse is a 409.
 */
export class PurchaseLedgerService {
  constructor(private readonly repo: EntitlementRepository) {}

  /**
   * Record (or re-touch) a purchase token for a user. Replay-safe and
   * idempotent. Writes an append-only audit row for every attempt.
   *
   * @throws ApiError.conflict if the token is already owned by another user.
   */
  async recordPurchase(params: RecordPurchaseParams): Promise<SubscriptionPurchase> {
    const { userId, purchaseToken, productId } = params;

    const existing = await this.repo.findPurchaseByToken(purchaseToken);

    if (existing && existing.userId !== userId) {
      // Token-sharing / replay across accounts. Never grant; record and reject.
      await this.repo.createAuditLog({
        eventType: AuditEventType.VERIFY_FAILED,
        source: AuditSource.CLIENT,
        userId,
        purchaseToken,
        processedOk: false,
        payload: { reason: 'token_owned_by_another_user', ownerUserId: existing.userId, productId },
      });
      throw ApiError.conflict('This purchase token is already associated with another account.');
    }

    const purchase = await this.repo.upsertPurchase({ userId, purchaseToken, productId });

    await this.repo.createAuditLog({
      eventType: existing ? AuditEventType.PURCHASE_UPDATED : AuditEventType.PURCHASE_RECORDED,
      source: AuditSource.CLIENT,
      userId,
      purchaseToken,
      payload: { productId, state: purchase.state },
    });

    return purchase;
  }

  getByToken(purchaseToken: string): Promise<SubscriptionPurchase | null> {
    return this.repo.findPurchaseByToken(purchaseToken);
  }
}
