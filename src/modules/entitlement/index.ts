import { prisma } from '../../database/prisma.js';
import { AndroidPublisherGooglePlayClient, type GooglePlayClient } from './google/google-play-client.js';
import { createEntitlementMiddleware, type EntitlementMiddleware } from './middleware/entitlement.middleware.js';
import { EntitlementRepository } from './repository/entitlement.repository.js';
import { EntitlementGuardService } from './service/entitlement-guard.service.js';
import { EntitlementService } from './service/entitlement.service.js';
import { LimitEvaluationService } from './service/limit-evaluation.service.js';
import { PurchaseLedgerService } from './service/purchase-ledger.service.js';
import { ReconciliationService } from './service/reconciliation.service.js';
import { RtdnService } from './service/rtdn.service.js';
import { VerificationService } from './service/verification.service.js';

/**
 * Monetization entitlement module (Phase 2A — foundation).
 *
 * Exposes the two foundational services so later phases can inject them:
 *   • PurchaseLedgerService — records purchase tokens (replay/idempotency-safe).
 *   • EntitlementService    — derives/grants/reads entitlements (source of truth).
 *
 * It intentionally exposes NO router: there is no new endpoint, no verification,
 * and no enforcement in this phase. The existing `subscription` module's
 * `POST /subscriptions/verify` continues to serve the legacy flow untouched.
 */
export interface EntitlementModule {
  repository: EntitlementRepository;
  entitlements: EntitlementService;
  purchases: PurchaseLedgerService;
  /** Real Google Play verification (Phase 2B). */
  verification: VerificationService;
  /** RTDN lifecycle synchronization (Phase 2C). */
  rtdn: RtdnService;
  /** Reconciliation + acknowledgment sweeps (Phase 2C). */
  reconciliation: ReconciliationService;
  /** Authoritative premium resolver (Phase 3). */
  guard: EntitlementGuardService;
  /** Quota evaluation + race-safe enforcement (Phase 3). */
  limits: LimitEvaluationService;
  /** HTTP entitlement guards (Phase 3). */
  middleware: EntitlementMiddleware;
  google: GooglePlayClient;
}

export function createEntitlementModule(): EntitlementModule {
  const repository = new EntitlementRepository(prisma);
  const entitlements = new EntitlementService(prisma, repository);
  const purchases = new PurchaseLedgerService(repository);
  const google = new AndroidPublisherGooglePlayClient();
  const verification = new VerificationService(prisma, repository, entitlements, google);
  const rtdn = new RtdnService(repository, verification);
  const reconciliation = new ReconciliationService(repository, verification, google);
  const guard = new EntitlementGuardService(repository);
  const limits = new LimitEvaluationService(guard);
  const middleware = createEntitlementMiddleware(guard);
  return { repository, entitlements, purchases, verification, rtdn, reconciliation, guard, limits, middleware, google };
}

export { EntitlementRepository } from './repository/entitlement.repository.js';
export { EntitlementService } from './service/entitlement.service.js';
export { PurchaseLedgerService } from './service/purchase-ledger.service.js';
export { VerificationService } from './service/verification.service.js';
export { RtdnService } from './service/rtdn.service.js';
export { ReconciliationService } from './service/reconciliation.service.js';
export { EntitlementGuardService } from './service/entitlement-guard.service.js';
export {
  LimitEvaluationService,
  freeGroupLimitError,
  premiumRequiredError,
  type GroupLimitDecision,
  type CountActiveGroups,
} from './service/limit-evaluation.service.js';
export { createEntitlementMiddleware, type EntitlementMiddleware } from './middleware/entitlement.middleware.js';
export type { GooglePlayClient } from './google/google-play-client.js';
export * from './constants.js';
