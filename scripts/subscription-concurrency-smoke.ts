/**
 * Cross-account purchase-token race smoke test (P0 security) — DB-free.
 *
 * Proves the invariant: a single Play purchase token can grant PREMIUM to AT
 * MOST ONE user, under every ordering — concurrent, sequential, replayed, and
 * duplicated. The fake models Postgres semantics faithfully enough to exercise
 * the real guards in VerificationService + EntitlementRepository:
 *
 *   • `acquireTokenLock` is a REAL per-token async mutex held for the lifetime
 *     of the transaction — exactly like `pg_advisory_xact_lock(hashtext(token))`
 *     — so two concurrent verifies of the same token serialize.
 *   • `lockPurchaseOwner` / `upsertVerifiedPurchase` enforce ownership, so a
 *     second account can never be bound to, or granted from, another's token.
 *
 * Scenarios:
 *   1. Two users verify the SAME token simultaneously → exactly one wins, one 409.
 *   2. Sequential ownership attempt (A then B) → B rejected 409, A keeps it.
 *   3. Replay attack (B re-presents A's token) → 409, B granted nothing.
 *   4. Duplicate verification (A twice) → idempotent: one row, one entitlement.
 *   5. Repo guard: upsertVerifiedPurchase refuses to re-own another account's row.
 *
 * Run: npm run smoke:verify-race
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SubscriptionPurchase, UserEntitlement } from '@prisma/client';
import { ApiError } from '../src/core/api-error.js';
import { EntitlementStatus, SETTLIO_PREMIUM_MONTHLY, SubscriptionState } from '../src/modules/entitlement/constants.js';
import type { GooglePlayClient } from '../src/modules/entitlement/google/google-play-client.js';
import type { NormalizedSubscription } from '../src/modules/entitlement/google/types.js';
import {
  type EntitlementRepository,
  PurchaseOwnershipError,
} from '../src/modules/entitlement/repository/entitlement.repository.js';
import { EntitlementService } from '../src/modules/entitlement/service/entitlement.service.js';
import { VerificationService } from '../src/modules/entitlement/service/verification.service.js';

interface TxCtx {
  releases: Array<() => void>;
}

/**
 * Fake that is BOTH the Prisma client and the repository. Its `$transaction`
 * runs the callback then releases any token locks the callback acquired, and
 * `acquireTokenLock` is a genuine per-token mutex — so concurrent transactions
 * on the same token serialize just as Postgres advisory xact locks would.
 */
class FakeDb {
  purchases = new Map<string, SubscriptionPurchase>(); // by token
  byId = new Map<string, string>(); // id → token
  entitlements: UserEntitlement[] = [];
  history: unknown[] = [];
  audit: { eventType: string; processedOk: boolean }[] = [];
  premiumCache = new Map<string, { isPremium: boolean; premiumExpiresAt: Date | null }>();

  private tails = new Map<string, Promise<void>>(); // token → tail of the lock queue

  async $transaction<T>(fn: (tx: TxCtx) => Promise<T>): Promise<T> {
    const ctx: TxCtx = { releases: [] };
    try {
      return await fn(ctx);
    } finally {
      // Release every token lock this transaction held (advisory xact lock is
      // released at COMMIT/ROLLBACK).
      for (const release of ctx.releases) release();
    }
  }

  async acquireTokenLock(token: string, tx?: TxCtx): Promise<void> {
    const prev = this.tails.get(token) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((res) => {
      release = res;
    });
    this.tails.set(
      token,
      prev.then(() => mine),
    );
    await prev; // block until the previous holder's transaction finishes
    if (tx) tx.releases.push(release);
    else release();
  }

  async lockPurchaseOwner(token: string): Promise<{ id: string; userId: string } | null> {
    const row = this.purchases.get(token);
    return row ? { id: row.id, userId: row.userId } : null;
  }

  async findPurchaseByToken(token: string) {
    return this.purchases.get(token) ?? null;
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
    if (existing && existing.userId !== input.userId) {
      throw new PurchaseOwnershipError(input.purchaseToken, existing.userId, input.userId);
    }
    const row = {
      ...(existing ?? { id: randomUUID(), createdAt: new Date(), latestGoogleState: null }),
      ...input,
      userId: existing ? existing.userId : input.userId, // ownership is immutable
      updatedAt: new Date(),
    } as unknown as SubscriptionPurchase;
    this.purchases.set(input.purchaseToken, row);
    this.byId.set(row.id, input.purchaseToken);
    return row;
  }

  async setAcknowledged(id: string) {
    const token = this.byId.get(id);
    if (token) this.purchases.set(token, { ...this.purchases.get(token)!, acknowledged: true });
    return {};
  }

  async createAuditLog(input: { eventType: string; processedOk?: boolean }) {
    this.audit.push({ eventType: input.eventType, processedOk: input.processedOk ?? true });
    return { id: randomUUID() };
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
      this.entitlements[idx] = {
        ...this.entitlements[idx],
        status: input.status,
        expiresAt: input.expiresAt,
      } as UserEntitlement;
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

class FakeGoogle implements GooglePlayClient {
  isConfigured = true;
  ackCalls = 0;
  async getSubscription(): Promise<NormalizedSubscription> {
    return {
      productId: SETTLIO_PREMIUM_MONTHLY,
      state: SubscriptionState.ACTIVE,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      autoRenewing: true,
      acknowledged: true, // skip ack network in this test
      orderId: 'GPA.RACE',
      purchasedAt: new Date(),
      linkedPurchaseToken: null,
      raw: { fake: true },
    };
  }
  async acknowledgeSubscription(): Promise<void> {
    this.ackCalls += 1;
  }
}

function build() {
  const db = new FakeDb();
  const repo = db as unknown as EntitlementRepository;
  const ents = new EntitlementService(db as never, repo);
  const svc = new VerificationService(db as never, repo, ents, new FakeGoogle());
  return { db, svc };
}

function is409(e: unknown): boolean {
  return e instanceof ApiError && e.statusCode === 409;
}

async function main(): Promise<void> {
  const userA = randomUUID();
  const userB = randomUUID();

  // 1. Two users verify the SAME token simultaneously → exactly one wins.
  {
    const { db, svc } = build();
    const token = `tok_${randomUUID()}`;
    const results = await Promise.allSettled([svc.verify(userA, token), svc.verify(userB, token)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one concurrent verify may succeed');
    assert.equal(rejected.length, 1, 'the other concurrent verify must fail');
    assert.ok(is409((rejected[0] as PromiseRejectedResult).reason), 'loser gets a 409 conflict');

    // Exactly one entitlement, one purchase row, both owned by the SAME winner.
    assert.equal(db.entitlements.length, 1, 'only one entitlement granted');
    assert.equal(db.purchases.size, 1, 'only one purchase row');
    const winner = db.entitlements[0]!.userId;
    assert.equal(db.purchases.get(token)?.userId, winner, 'purchase + entitlement owned by the same user');
    const loser = winner === userA ? userB : userA;
    assert.equal(await db.findActiveEntitlement(loser, 'PREMIUM'), null, 'loser granted nothing');
    assert.ok(!db.premiumCache.get(loser)?.isPremium, 'loser premium cache not set');
    console.log(`✓ concurrent verify: exactly one winner (${winner === userA ? 'A' : 'B'}), other 409`);
  }

  // 2. Sequential ownership attempt: A verifies, then B → B rejected, A keeps it.
  {
    const { db, svc } = build();
    const token = `tok_${randomUUID()}`;
    const a = await svc.verify(userA, token);
    assert.equal(a.isPremium, true, 'A obtains premium');

    await assert.rejects(() => svc.verify(userB, token), is409, 'B sequential attempt must 409');
    assert.equal(db.purchases.get(token)?.userId, userA, 'ownership unchanged (A)');
    assert.equal(await db.findActiveEntitlement(userB, 'PREMIUM'), null, 'B granted nothing');
    assert.equal(db.entitlements.length, 1, 'still one entitlement');
    console.log('✓ sequential ownership: second user rejected (409), no grant');
  }

  // 3. Replay attack: B replays A's token repeatedly → always 409, never granted.
  {
    const { db, svc } = build();
    const token = `tok_${randomUUID()}`;
    await svc.verify(userA, token);
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => svc.verify(userB, token), is409, `replay #${i + 1} must 409`);
    }
    assert.equal(await db.findActiveEntitlement(userB, 'PREMIUM'), null, 'replay never grants B');
    assert.equal(db.entitlements.length, 1, 'no extra entitlement from replays');
    assert.ok(
      db.audit.some((a) => a.eventType === 'VERIFY_FAILED' && !a.processedOk),
      'replay failures are audited',
    );
    console.log('✓ replay attack: every reuse blocked (409), audited, nothing granted');
  }

  // 4. Duplicate verification by the OWNER → idempotent.
  {
    const { db, svc } = build();
    const token = `tok_${randomUUID()}`;
    const r1 = await svc.verify(userA, token);
    const r2 = await svc.verify(userA, token);
    const r3 = await svc.verify(userA, token);
    assert.ok(r1.isPremium && r2.isPremium && r3.isPremium, 'owner stays premium across duplicates');
    assert.equal(db.purchases.size, 1, 'no duplicate purchase row');
    assert.equal(db.entitlements.length, 1, 'no duplicate entitlement');
    console.log('✓ duplicate verification by owner is idempotent (one row, one entitlement)');
  }

  // 5. Repo-level guard: upsertVerifiedPurchase refuses to re-own another account.
  {
    const { db } = build();
    const token = `tok_${randomUUID()}`;
    const base = {
      purchaseToken: token,
      productId: SETTLIO_PREMIUM_MONTHLY,
      state: SubscriptionState.ACTIVE,
      orderId: null,
      purchasedAt: null,
      expiresAt: new Date(Date.now() + 1000),
      autoRenewing: true,
      acknowledged: true,
      linkedPurchaseToken: null,
      latestGoogleState: { fake: true } as never,
    };
    await db.upsertVerifiedPurchase({ ...base, userId: userA });
    await assert.rejects(
      () => db.upsertVerifiedPurchase({ ...base, userId: userB }),
      (e: unknown) => e instanceof PurchaseOwnershipError,
      'repo must reject a cross-account update',
    );
    assert.equal(db.purchases.get(token)?.userId, userA, 'owner never mutated by a foreign upsert');
    console.log('✓ repo guard: upsertVerifiedPurchase never re-owns another account');
  }

  console.log('\nAll cross-account token-race checks passed ✅');
}

main().catch((err: unknown) => {
  console.error('✗ concurrency smoke failed:', err);
  process.exit(1);
});
