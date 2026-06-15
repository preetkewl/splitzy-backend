/**
 * Entitlement foundation smoke test (Phase 2A) — DB-free.
 *
 * Follows the project convention of testing services against an in-memory fake
 * repository (no live database — the real DB is production). It exercises the
 * SERVICE-level invariants of the foundation:
 *
 *   1. PurchaseLedgerService idempotency — recording the same (user, token)
 *      twice yields one row, not two.
 *   2. Replay / token-sharing guard — a token owned by user A cannot be claimed
 *      by user B (409 conflict).
 *   3. EntitlementService.deriveStatus pure logic.
 *   4. grant() idempotency — re-granting from the same source updates the one
 *      entitlement row, appends history, and refreshes the premium cache.
 *   5. close() transitions an active entitlement and clears the cache.
 *
 * The DB-level uniqueness/replay guarantees (unique purchaseToken, unique
 * entitlement source key, unique googleMessageId) are enforced by the migration
 * indexes and are verified by review of the migration SQL, not here.
 *
 * Run: npm run smoke:entitlement
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SubscriptionPurchase, UserEntitlement } from '@prisma/client';
import { ApiError } from '../src/core/api-error.js';
import {
  EntitlementChangeReason,
  EntitlementSource,
  EntitlementStatus,
  EntitlementType,
  SETTLIO_PREMIUM_MONTHLY,
  SubscriptionState,
} from '../src/modules/entitlement/constants.js';
import type { EntitlementRepository } from '../src/modules/entitlement/repository/entitlement.repository.js';
import { EntitlementService } from '../src/modules/entitlement/service/entitlement.service.js';
import { PurchaseLedgerService } from '../src/modules/entitlement/service/purchase-ledger.service.js';

// ── In-memory fake repository (mirrors the Prisma constraints in plain maps) ───
class FakeRepo {
  purchases = new Map<string, SubscriptionPurchase>(); // keyed by purchaseToken
  entitlements: UserEntitlement[] = [];
  history: unknown[] = [];
  audit: unknown[] = [];
  premiumCache = new Map<string, { isPremium: boolean; premiumExpiresAt: Date | null }>();

  async findPurchaseByToken(token: string) {
    return this.purchases.get(token) ?? null;
  }

  async upsertPurchase(input: { userId: string; purchaseToken: string; productId: string }) {
    const existing = this.purchases.get(input.purchaseToken);
    const row = {
      ...(existing ?? {
        id: randomUUID(),
        orderId: null,
        state: SubscriptionState.PENDING,
        purchasedAt: null,
        expiresAt: null,
        autoRenewing: false,
        acknowledged: false,
        linkedPurchaseToken: null,
        latestGoogleState: null,
        createdAt: new Date(),
      }),
      userId: input.userId,
      purchaseToken: input.purchaseToken,
      productId: input.productId,
      updatedAt: new Date(),
    } as SubscriptionPurchase;
    this.purchases.set(input.purchaseToken, row);
    return row;
  }

  async createAuditLog(input: unknown) {
    this.audit.push(input);
    return { id: randomUUID() };
  }

  async findActiveEntitlement(userId: string, entitlement: EntitlementType, now = new Date()) {
    const rows = this.entitlements
      .filter(
        (e) =>
          e.userId === userId &&
          e.entitlement === entitlement &&
          e.status === EntitlementStatus.ACTIVE &&
          (e.expiresAt === null || e.expiresAt > now),
      )
      .sort((a, b) => (b.expiresAt?.getTime() ?? Infinity) - (a.expiresAt?.getTime() ?? Infinity));
    return rows[0] ?? null;
  }

  async findActiveEntitlementsOfType(userId: string, entitlement: EntitlementType, now = new Date()) {
    return this.entitlements.filter(
      (e) =>
        e.userId === userId &&
        e.entitlement === entitlement &&
        e.status === EntitlementStatus.ACTIVE &&
        (e.expiresAt === null || e.expiresAt > now),
    );
  }

  async upsertEntitlement(input: {
    userId: string;
    entitlement: EntitlementType;
    source: EntitlementSource;
    sourceRef: string | null;
    status: EntitlementStatus;
    startsAt?: Date;
    expiresAt: Date | null;
  }) {
    const idx = this.entitlements.findIndex(
      (e) =>
        e.userId === input.userId &&
        e.entitlement === input.entitlement &&
        e.source === input.source &&
        e.sourceRef === input.sourceRef,
    );
    if (idx >= 0) {
      const updated = {
        ...this.entitlements[idx],
        status: input.status,
        expiresAt: input.expiresAt,
        updatedAt: new Date(),
      } as UserEntitlement;
      this.entitlements[idx] = updated;
      return updated;
    }
    const row = {
      id: randomUUID(),
      userId: input.userId,
      entitlement: input.entitlement,
      source: input.source,
      sourceRef: input.sourceRef,
      status: input.status,
      startsAt: input.startsAt ?? new Date(),
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as UserEntitlement;
    this.entitlements.push(row);
    return row;
  }

  async createHistory(input: unknown) {
    this.history.push(input);
    return input as never;
  }

  async updatePremiumCache(userId: string, isPremium: boolean, premiumExpiresAt: Date | null) {
    this.premiumCache.set(userId, { isPremium, premiumExpiresAt });
    return {};
  }
}

// Fake Prisma client whose $transaction simply runs the callback (the fake repo
// ignores the executor argument, so the same maps are mutated either way).
const fakePrisma = {
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
} as never;

async function main(): Promise<void> {
  const repo = new FakeRepo();
  const ledger = new PurchaseLedgerService(repo as unknown as EntitlementRepository);
  const ents = new EntitlementService(fakePrisma, repo as unknown as EntitlementRepository);

  const userA = randomUUID();
  const userB = randomUUID();
  const token = `tok_${randomUUID()}`;

  // 1. Idempotent purchase recording — same user, same token → one row.
  const p1 = await ledger.recordPurchase({ userId: userA, purchaseToken: token, productId: SETTLIO_PREMIUM_MONTHLY });
  const p2 = await ledger.recordPurchase({ userId: userA, purchaseToken: token, productId: SETTLIO_PREMIUM_MONTHLY });
  assert.equal(p1.id, p2.id, 'idempotent recordPurchase must return the same row');
  assert.equal(repo.purchases.size, 1, 'no duplicate purchase row');
  assert.equal(p1.state, SubscriptionState.PENDING, 'foundation purchases are PENDING (unverified, grant nothing)');
  console.log('✓ purchase recording is idempotent');

  // 2. Replay / token-sharing guard — user B cannot claim user A's token.
  await assert.rejects(
    () => ledger.recordPurchase({ userId: userB, purchaseToken: token, productId: SETTLIO_PREMIUM_MONTHLY }),
    (err: unknown) => err instanceof ApiError && err.statusCode === 409,
    'cross-user token reuse must 409',
  );
  assert.equal(repo.purchases.get(token)?.userId, userA, 'token ownership unchanged after rejected replay');
  console.log('✓ replay / token-sharing guard rejects cross-user reuse');

  // 3. deriveStatus pure logic.
  const now = new Date('2026-06-10T00:00:00Z');
  assert.equal(EntitlementService.deriveStatus(null, now), EntitlementStatus.ACTIVE, 'perpetual → ACTIVE');
  assert.equal(
    EntitlementService.deriveStatus(new Date('2026-07-10T00:00:00Z'), now),
    EntitlementStatus.ACTIVE,
    'future expiry → ACTIVE',
  );
  assert.equal(
    EntitlementService.deriveStatus(new Date('2026-05-10T00:00:00Z'), now),
    EntitlementStatus.EXPIRED,
    'past expiry → EXPIRED',
  );
  console.log('✓ deriveStatus pure logic correct');

  // 4. grant() idempotency + history + cache refresh.
  const expiry = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const g1 = await ents.grant({
    userId: userA,
    entitlement: EntitlementType.PREMIUM,
    source: EntitlementSource.SUBSCRIPTION,
    sourceRef: p1.id,
    expiresAt: expiry,
    reason: EntitlementChangeReason.PURCHASE_VERIFIED,
    relatedPurchaseId: p1.id,
  });
  const laterExpiry = new Date(expiry.getTime() + 30 * 24 * 3600 * 1000);
  const g2 = await ents.grant({
    userId: userA,
    entitlement: EntitlementType.PREMIUM,
    source: EntitlementSource.SUBSCRIPTION,
    sourceRef: p1.id, // same source → renewal, not a new grant
    expiresAt: laterExpiry,
    reason: EntitlementChangeReason.RENEWAL,
    relatedPurchaseId: p1.id,
  });
  assert.equal(g1.id, g2.id, 're-grant from same source must update the one row');
  assert.equal(repo.entitlements.length, 1, 'no duplicate entitlement row');
  assert.equal(g2.expiresAt?.getTime(), laterExpiry.getTime(), 'renewal extends expiry');
  assert.equal(repo.history.length, 2, 'each transition appends one history row');
  assert.equal(repo.premiumCache.get(userA)?.isPremium, true, 'premium cache reflects active grant');
  assert.ok(await ents.hasEntitlement(userA), 'user A holds PREMIUM');
  assert.ok(!(await ents.hasEntitlement(userB)), 'user B holds nothing');
  console.log('✓ grant() is idempotent, records history, refreshes cache');

  // 5. close() revokes and clears the cache.
  await ents.close(
    userA,
    EntitlementType.PREMIUM,
    EntitlementStatus.REVOKED,
    EntitlementChangeReason.REVOCATION,
    p1.id,
  );
  assert.ok(!(await ents.hasEntitlement(userA)), 'revoked entitlement is no longer active');
  assert.equal(repo.premiumCache.get(userA)?.isPremium, false, 'premium cache cleared on revoke');
  assert.equal(repo.history.length, 3, 'revoke appends a history row');
  console.log('✓ close() revokes entitlement and clears cache');

  console.log('\nAll entitlement foundation checks passed ✅');
}

main().catch((err: unknown) => {
  console.error('✗ entitlement smoke failed:', err);
  process.exit(1);
});
