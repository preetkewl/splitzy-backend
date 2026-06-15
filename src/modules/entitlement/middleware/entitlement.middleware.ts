import type { RequestHandler } from 'express';
import { asyncHandler } from '../../../core/async-handler.js';
import { ApiError } from '../../../core/api-error.js';
import type { EntitlementGuardService } from '../service/entitlement-guard.service.js';
import { premiumRequiredError } from '../service/limit-evaluation.service.js';

export interface EntitlementMiddleware {
  /** Hard gate: 403 PREMIUM_REQUIRED unless the user holds active premium. */
  requirePremium: RequestHandler;
  /** Never blocks: resolves premium state and attaches it to `req.entitlement`. */
  optionalPremium: RequestHandler;
  /** Alias of optionalPremium, named for the "resolver" role in the pipeline. */
  resolveEntitlement: RequestHandler;
}

/**
 * Entitlement-aware HTTP guards, built over the authoritative
 * {@link EntitlementGuardService}. Designed to sit after `requireAuth` (which
 * populates `req.user`). They read live entitlement state — never the stale
 * User.isPremium cache — and are entitlement-type-agnostic so future gates
 * (e.g. a specific feature entitlement) reuse the same shape.
 */
export function createEntitlementMiddleware(guard: EntitlementGuardService): EntitlementMiddleware {
  const requirePremium: RequestHandler = asyncHandler(async (req, _res, next) => {
    const userId = req.user?.id;
    if (!userId) throw ApiError.unauthorized();
    const snapshot = await guard.resolve(userId);
    if (!snapshot.premium) throw premiumRequiredError();
    req.entitlement = snapshot;
    next();
  });

  const resolveEntitlement: RequestHandler = asyncHandler(async (req, _res, next) => {
    const userId = req.user?.id;
    // Non-blocking: anonymous / unauthenticated requests simply get no snapshot.
    req.entitlement = userId ? await guard.resolve(userId) : { premium: false, premiumExpiresAt: null };
    next();
  });

  return { requirePremium, optionalPremium: resolveEntitlement, resolveEntitlement };
}
