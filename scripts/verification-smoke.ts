/**
 * Google Play verification smoke test (Phase 2B) — DB-free, network-free.
 *
 * Exercises VerificationService against an in-memory fake repository and a fake
 * GooglePlayClient (so no credentials / no Google contact). Asserts the Phase-2B
 * guarantees:
 *
 *   1. Fake/unknown tokens are rejected (Google says invalid → 400, no grant).
 *   2. Valid ACTIVE tokens are verified → premium granted, purchase persisted,
 *      product/expiry derived from GOOGLE (not the client).
 *   3. Acknowledgment: called when Google reports NOT acknowledged; skipped when
 *      already acknowledged.
 *   4. Replay / token-sharing across users → 409, no grant.
 *   5. Duplicate verify is idempotent (one purchase row, one entitlement).
 *   6. Non-entitling state (expired) → not premium, entitlement closed.
 *
 * Run: npm run smoke:verification
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SubscriptionPurchase, UserEntitlement } from '@prisma/client';
import { ApiError } from '../src/core/api-error.js';
import { EntitlementStatus, SETTLIO_PREMIUM_MONTHLY, SubscriptionState } from '../src/modules/entitlement/constants.js';
import type { GooglePlayClient } from '../src/modules/entitlement/google/google-play-client.js';
import { InvalidPurchaseTokenError, type NormalizedSubscription } from '../src/modules/entitlement/google/types.js';
import { type EntitlementRepository, PurchaseOwnershipError } from '../src/modules/entitlement/repository/entitlement.repository.js';
import { EntitlementService } from '../src/modules/entitlement/service/entitlement.service.js';
import { VerificationService } from '../src/modules/entitlement/service/verification.service.js';

// ── Fake repository ────────────────────────────────────────────────────────────
class FakeRepo {
  purchases = new Map<string, SubscriptionPurchase>(); // by token
  entitlements: UserEntitlement[] = [];
  history: unknown[] = [];
  audit: { eventType: string; processedOk: boolean }[] = [];
  premiumCache = new Map<string, { isPremium: boolean; premiumExpiresAt: Date | null }>();

  async createAuditLog(input: { eventType: string; processedOk?: boolean }) {
    this.audit.push({ eventType: input.eventType, processedOk: input.processedOk ?? true });
    return { id: randomUUID() };
  }
  async findPurchaseByToken(token: string) {
    return this.purchases.get(token) ?? null;
  }
  // Advisory lock is a no-op in the fake (single-process, sequential).
  async acquireTokenLock(_token: string) {}
  async lockPurchaseOwner(token: string) {
    const row = this.purchases.get(token);
    return row ? { id: row.id, userId: row.userId } : null;
  }
  async upsertVerifiedPurchase(input: {
    userId: string;
    purchaseToken: string;
    productId: string;
    state: SubscriptionState;
    orderId: string | null;
    purchasedAt: Date | null;
    expiresAt: Date | null;
    autoRenewing: boolean;
    acknowledged: boolean;
    linkedPurchaseToken: string | null;
  }) {
    const existing = this.purchases.get(input.purchaseToken);
    // Ownership-safe, mirroring the real repo: never re-own another account's row.
    if (existing && existing.userId !== input.userId) {
      throw new PurchaseOwnershipError(input.purchaseToken, existing.userId, input.userId);
    }
    const row = {
      ...(existing ?? { id: randomUUID(), createdAt: new Date(), latestGoogleState: null }),
      ...input,
      // userId is immutable once set — keep the original owner explicitly.
      userId: existing ? existing.userId : input.userId,
      updatedAt: new Date(),
    } as unknown as SubscriptionPurchase;
    this.purchases.set(input.purchaseToken, row);
    return row;
  }
  async setAcknowledged(purchaseId: string) {
    for (const [k, v] of this.purchases) {
      if (v.id === purchaseId) this.purchases.set(k, { ...v, acknowledged: true });
    }
    return {};
  }
  async findActiveEntitlement(userId: string, entitlement: string, now = new Date()) {
    return (
      this.entitlements.find(
        (e) =>
          e.userId === userId &&
          e.entitlement === entitlement &&
          e.status === EntitlementStatus.ACTIVE &&
          (e.expiresAt === null || e.expiresAt > now),
      ) ?? null
    );
  }
  async findActiveEntitlementBySource(userId: string, entitlement: string, source: string, sourceRef: string) {
    return (
      this.entitlements.find(
        (e) =>
          e.userId === userId &&
          e.entitlement === entitlement &&
          e.source === source &&
          e.sourceRef === sourceRef &&
          e.status === EntitlementStatus.ACTIVE,
      ) ?? null
    );
  }
  async findActiveEntitlementsOfType(userId: string, entitlement: string, now = new Date()) {
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
    entitlement: string;
    source: string;
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
      this.entitlements[idx] = { ...this.entitlements[idx], status: input.status, expiresAt: input.expiresAt } as UserEntitlement;
      return this.entitlements[idx];
    }
    const row = {
      id: randomUUID(),
      ...input,
      startsAt: input.startsAt ?? new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as UserEntitlement;
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

// ── Fake Google client ───────────────────────────────────────────────────────
class FakeGoogle implements GooglePlayClient {
  isConfigured = true;
  ackCalls = 0;
  constructor(private next: NormalizedSubscription | (() => never)) {}
  async getSubscription(): Promise<NormalizedSubscription> {
    if (typeof this.next === 'function') return this.next();
    return this.next;
  }
  async acknowledgeSubscription(): Promise<void> {
    this.ackCalls += 1;
  }
  set(value: NormalizedSubscription) {
    this.next = value;
  }
}

const fakePrisma = { $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}) } as never;

function activeSub(overrides: Partial<NormalizedSubscription> = {}): NormalizedSubscription {
  return {
    productId: SETTLIO_PREMIUM_MONTHLY,
    state: SubscriptionState.ACTIVE,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    autoRenewing: true,
    acknowledged: false,
    orderId: 'GPA.1234',
    purchasedAt: new Date(),
    linkedPurchaseToken: null,
    raw: { fake: true },
    ...overrides,
  };
}

function build(google: GooglePlayClient) {
  const repo = new FakeRepo();
  const ents = new EntitlementService(fakePrisma, repo as unknown as EntitlementRepository);
  const svc = new VerificationService(fakePrisma, repo as unknown as EntitlementRepository, ents, google);
  return { repo, svc };
}

async function main(): Promise<void> {
  const userA = randomUUID();
  const userB = randomUUID();

  // 1. Fake token rejected.
  {
    const google = new FakeGoogle(() => {
      throw new InvalidPurchaseTokenError();
    });
    const { repo, svc } = build(google);
    await assert.rejects(
      () => svc.verify(userA, 'bogus-token'),
      (e: unknown) => e instanceof ApiError && e.statusCode === 400,
      'fake token must be rejected with 400',
    );
    assert.equal(repo.purchases.size, 0, 'no purchase persisted for fake token');
    assert.ok(repo.audit.some((a) => a.eventType === 'VERIFY_FAILED'), 'failure audited');
    console.log('✓ fake/unknown token rejected (400), nothing granted');
  }

  // 2. Valid ACTIVE token verified; product/expiry derived from Google; ack called.
  {
    const google = new FakeGoogle(activeSub());
    const { repo, svc } = build(google);
    const token = `tok_${randomUUID()}`;
    const res = await svc.verify(userA, token);
    assert.equal(res.isPremium, true, 'active sub → premium');
    assert.equal(res.productId, SETTLIO_PREMIUM_MONTHLY, 'product derived from Google');
    assert.ok(res.expiresAt, 'expiry derived from Google');
    assert.equal(repo.purchases.get(token)?.state, SubscriptionState.ACTIVE, 'purchase persisted ACTIVE');
    assert.equal(repo.entitlements.length, 1, 'one entitlement granted');
    assert.equal(repo.premiumCache.get(userA)?.isPremium, true, 'premium cache set');
    assert.equal(google.ackCalls, 1, 'unacknowledged purchase is acknowledged');
    assert.equal(repo.purchases.get(token)?.acknowledged, true, 'ack persisted');
    console.log('✓ valid token verified; product/expiry from Google; acknowledged');

    // 5. Duplicate verify is idempotent (same client instance/state).
    const res2 = await svc.verify(userA, token);
    assert.equal(res2.isPremium, true, 'repeat verify still premium');
    assert.equal(repo.purchases.size, 1, 'no duplicate purchase row');
    assert.equal(repo.entitlements.length, 1, 'no duplicate entitlement');
    console.log('✓ duplicate verify is idempotent (one purchase, one entitlement)');

    // 3b. Ack skipped when Google reports already acknowledged.
    const ackBefore = google.ackCalls;
    google.set(activeSub({ acknowledged: true }));
    await svc.verify(userA, token);
    assert.equal(google.ackCalls, ackBefore, 'no re-acknowledge when already acknowledged');
    console.log('✓ acknowledgment skipped when already acknowledged');

    // 4. Replay: user B presents user A's token → 409, no grant for B.
    await assert.rejects(
      () => svc.verify(userB, token),
      (e: unknown) => e instanceof ApiError && e.statusCode === 409,
      'cross-user token reuse must 409',
    );
    assert.equal(repo.purchases.get(token)?.userId, userA, 'ownership unchanged');
    assert.ok(!(await ents_hasB(repo, userB)), 'user B granted nothing');
    console.log('✓ replay / token-sharing across users blocked (409)');
  }

  // 6. Non-entitling state (expired) → not premium, entitlement closed.
  {
    const google = new FakeGoogle(
      activeSub({ state: SubscriptionState.EXPIRED, expiresAt: new Date(Date.now() - 1000), acknowledged: true }),
    );
    const { repo, svc } = build(google);
    const token = `tok_${randomUUID()}`;
    const res = await svc.verify(userA, token);
    assert.equal(res.isPremium, false, 'expired sub → not premium');
    assert.ok(!repo.premiumCache.get(userA)?.isPremium, 'cache reflects no premium');
    assert.equal(repo.entitlements.length, 0, 'no entitlement granted for expired sub');
    assert.equal(google.ackCalls, 0, 'expired purchase not acknowledged');
    console.log('✓ expired/non-entitling state → not premium, no grant');
  }

  console.log('\nAll Google Play verification checks passed ✅');
}

async function ents_hasB(repo: FakeRepo, userId: string): Promise<boolean> {
  return (await repo.findActiveEntitlement(userId, 'PREMIUM')) !== null;
}

main().catch((err: unknown) => {
  console.error('✗ verification smoke failed:', err);
  process.exit(1);
});
