/**
 * Entitlement enforcement smoke test (Phase 3) — DB-free, no network.
 *
 * Exercises EntitlementGuardService + LimitEvaluationService + the premium
 * middleware against in-memory fakes. Covers the Phase-3 validation matrix:
 *
 *   1. free users blocked after FREE_ACTIVE_GROUP_LIMIT active groups
 *   2. premium users unlimited
 *   3. archived/deleted groups free a slot (count excludes deletedAt)
 *   4. race-condition guard: an advisory lock is taken before the count
 *   5. authoritative server count (no client trust)
 *   6. refunds/revocations remove premium (entitlement gone → limit applies)
 *   7. stale frontend premium cannot bypass (guard reads entitlements, not isPremium)
 *   8. premium middleware resolves / blocks correctly
 *
 * Run: npm run smoke:enforcement
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { ApiError } from '../src/core/api-error.js';
import { FREE_ACTIVE_GROUP_LIMIT } from '../src/modules/entitlement/constants.js';
import { createEntitlementMiddleware } from '../src/modules/entitlement/middleware/entitlement.middleware.js';
import type { EntitlementRepository } from '../src/modules/entitlement/repository/entitlement.repository.js';
import { EntitlementGuardService } from '../src/modules/entitlement/service/entitlement-guard.service.js';
import { LimitEvaluationService } from '../src/modules/entitlement/service/limit-evaluation.service.js';

// Fake entitlement repo — only findActiveEntitlement is used by the guard.
class FakeEntRepo {
  private active = new Set<string>(); // userIds holding active PREMIUM
  grant(userId: string) {
    this.active.add(userId);
  }
  revoke(userId: string) {
    this.active.delete(userId);
  }
  async findActiveEntitlement(userId: string) {
    return this.active.has(userId) ? ({ expiresAt: new Date(Date.now() + 1e9) } as never) : null;
  }
}

// Fake transaction with a tracked advisory-lock call + a trip.count honoring `where`.
interface FakeTrip {
  createdById: string;
  deletedAt: Date | null;
}
function makeTx(trips: FakeTrip[]) {
  const state = { lockCalls: 0 };
  const tx = {
    state,
    $executeRaw: async () => {
      state.lockCalls += 1;
      return 1;
    },
    trip: {
      count: async ({ where }: { where: { createdById: string; deletedAt: null } }) =>
        trips.filter((t) => t.createdById === where.createdById && t.deletedAt === null).length,
    },
  };
  return tx;
}

function invokeMiddleware(
  mw: (req: Request, res: Response, next: (err?: unknown) => void) => void,
  req: Partial<Request>,
): Promise<{ err?: unknown; req: Partial<Request> }> {
  return new Promise((resolve) => {
    mw(req as Request, {} as Response, (err?: unknown) => resolve({ err, req }));
  });
}

async function main(): Promise<void> {
  const repo = new FakeEntRepo();
  const guard = new EntitlementGuardService(repo as unknown as EntitlementRepository);
  const limits = new LimitEvaluationService(guard);

  const free = randomUUID();
  const premium = randomUUID();
  repo.grant(premium);

  // The exact closure TripService uses (counts active, non-deleted, owned).
  const countActive = (tx: ReturnType<typeof makeTx>, userId: string) => () =>
    tx.trip.count({ where: { createdById: userId, deletedAt: null } });

  // 1 + 4 + 5. Free user at the limit is blocked; lock taken first.
  {
    const owned: FakeTrip[] = Array.from({ length: FREE_ACTIVE_GROUP_LIMIT }, () => ({ createdById: free, deletedAt: null }));
    const tx = makeTx(owned);
    await assert.rejects(
      () => limits.enforceGroupCreation(tx as never, free, countActive(tx, free)),
      (e: unknown) =>
        e instanceof ApiError &&
        e.statusCode === 403 &&
        e.code === 'FREE_GROUP_LIMIT_REACHED' &&
        (e.details?.meta as { usage: number; limit: number }).usage === FREE_ACTIVE_GROUP_LIMIT,
      'free user at limit must be blocked with structured error',
    );
    assert.equal(tx.state.lockCalls, 1, 'advisory lock acquired before evaluation (race guard)');
    console.log(`✓ free user blocked at ${String(FREE_ACTIVE_GROUP_LIMIT)} active groups (structured 403, lock taken)`);
  }

  // 1b. Free user under the limit is allowed.
  {
    const tx = makeTx([{ createdById: free, deletedAt: null }]);
    await limits.enforceGroupCreation(tx as never, free, countActive(tx, free));
    console.log('✓ free user under limit allowed');
  }

  // 2. Premium user is unlimited.
  {
    const owned: FakeTrip[] = Array.from({ length: 99 }, () => ({ createdById: premium, deletedAt: null }));
    const tx = makeTx(owned);
    await limits.enforceGroupCreation(tx as never, premium, countActive(tx, premium));
    console.log('✓ premium user unlimited');
  }

  // 3. Archived/deleted groups don't count toward the free limit.
  {
    const owned: FakeTrip[] = [
      { createdById: free, deletedAt: null },
      { createdById: free, deletedAt: new Date() }, // deleted — must not count
      { createdById: free, deletedAt: new Date() },
    ];
    const tx = makeTx(owned);
    await limits.enforceGroupCreation(tx as never, free, countActive(tx, free)); // only 1 active → allowed
    const decision = await limits.evaluateGroupCreation(free, countActive(tx, free), tx as never);
    assert.equal(decision.usage, 1, 'deleted groups excluded from usage');
    console.log('✓ archived/deleted groups free a slot (usage counts active only)');
  }

  // 6 + 7. Stale "frontend premium" cannot bypass: guard reads entitlements only.
  //        A revoked entitlement immediately drops premium.
  {
    const u = randomUUID();
    assert.equal(await guard.isPremium(u), false, 'no entitlement → not premium (ignores any client claim)');
    repo.grant(u);
    assert.equal(await guard.isPremium(u), true, 'granted → premium');
    repo.revoke(u); // refund/revocation
    assert.equal(await guard.isPremium(u), false, 'revoked → premium removed');
    console.log('✓ refund/revocation removes premium; stale client premium cannot bypass');
  }

  // 8. Premium middleware.
  {
    const mw = createEntitlementMiddleware(guard);

    const blocked = await invokeMiddleware(mw.requirePremium, { user: { id: free } });
    assert.ok(
      blocked.err instanceof ApiError && blocked.err.code === 'PREMIUM_REQUIRED',
      'requirePremium blocks non-premium with PREMIUM_REQUIRED',
    );

    const allowed = await invokeMiddleware(mw.requirePremium, { user: { id: premium } });
    assert.equal(allowed.err, undefined, 'requirePremium passes premium user');
    assert.equal(allowed.req.entitlement?.premium, true, 'requirePremium attaches snapshot');

    const optional = await invokeMiddleware(mw.optionalPremium, { user: { id: free } });
    assert.equal(optional.err, undefined, 'optionalPremium never blocks');
    assert.equal(optional.req.entitlement?.premium, false, 'optionalPremium attaches free snapshot');
    console.log('✓ premium middleware resolves and blocks correctly');
  }

  console.log('\nAll entitlement enforcement checks passed ✅');
}

main().catch((err: unknown) => {
  console.error('✗ enforcement smoke failed:', err);
  process.exit(1);
});
