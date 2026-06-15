import type { VerificationService } from '../../entitlement/service/verification.service.js';
import type { SubscriptionStatusDto } from '../dto/index.js';

/**
 * Thin adapter over the entitlement module's real Google Play
 * {@link VerificationService} (Phase 2B). The previous Phase-1 implementation
 * fake-granted premium by writing legacy User fields directly; that path —
 * along with its repository — has been removed. The backend now trusts ONLY
 * Google: it derives product, state and expiry server-side, so the client's
 * claimed productId is never used.
 */
export class SubscriptionService {
  constructor(private readonly verification: VerificationService) {}

  verify(userId: string, purchaseToken: string): Promise<SubscriptionStatusDto> {
    return this.verification.verify(userId, purchaseToken);
  }
}
