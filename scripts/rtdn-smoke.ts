/**
 * RTDN + reconciliation + acknowledgment smoke test (Phase 2C) — DB-free, no network.
 *
 * Drives RtdnService / ReconciliationService / VerificationService against an
 * in-memory fake repository and a programmable fake GooglePlayClient. Covers the
 * Phase-2C validation matrix:
 *
 *   1. duplicate RTDN safely ignored
 *   2. renewals extend entitlement
 *   3. cancellations stay entitled (until expiry)
 *   4. refunds (voided) revoke entitlement immediately
 *   5. expired subscriptions lose entitlement
 *   6. out-of-order events don't corrupt state (Google truth always wins)
 *   7. reconciliation repairs drift (missed RTDN)
 *   8. acknowledgment sweep recovers a failed ack
 *   9. replay protection still intact (cross-user token reuse → 409)
 *
 * Run: npm run smoke:rtdn
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, type SubscriptionPurchase, type UserEntitlement } from '@prisma/client';
import { ApiError } from '../src/core/api-error.js';
import { EntitlementStatus, SETTLIO_PREMIUM_MONTHLY, SubscriptionState } from '../src/modules/entitlement/constants.js';
import type { GooglePlayClient } from '../src/modules/entitlement/google/google-play-client.js';
import { SUB_NOTIFICATION } from '../src/modules/entitlement/google/rtdn-types.js';
import { InvalidPurchaseTokenError, type NormalizedSubscription } from '../src/modules/entitlement/google/types.js';
import { type EntitlementRepository, PurchaseOwnershipError } from '../src/modules/entitlement/repository/entitlement.repository.js';
import { EntitlementService } from '../src/modules/entitlement/service/entitlement.service.js';
import { ReconciliationService } from '../src/modules/entitlement/service/reconciliation.service.js';
import { RtdnService } from '../src/modules/entitlement/service/rtdn.service.js';
import { VerificationService } from '../src/modules/entitlement/service/verification.service.js';

// ── Fake repository ────────────────────────────────────────────────────────────
class FakeRepo {
  purchases = new Map<string, SubscriptionPurchase>(); // by token
  byId = new Map<string, string>(); // purchaseId → token
  entitlements: UserEntitlement[] = [];
  history: unknown[] = [];
  auditByMessageId = new Map<string, unknown>();

  premiumCache = new Map<string, { isPremium: boolean; premiumExpiresAt: Date | null }>();

  async createAuditLog(input: { googleMessageId?: string | null }) {
    const mid = input.googleMessageId;
    if (mid) {
      if (this.auditByMessageId.has(mid)) {
        throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
      }
      this.auditByMessageId.set(mid, input);
    }
    return { id: randomUUID() };
  }
  async findAuditByGoogleMessageId(mid: string) {
    return this.auditByMessageId.has(mid) ? { id: 'x' } : null;
  }
  async findPurchaseByToken(token: string) {
    return this.purchases.get(token) ?? null;
  }
  async acquireTokenLock(_token: string) {}
  async lockPurchaseOwner(token: string) {
    const row = this.purchases.get(token);
    return row ? { id: row.id, userId: row.userId } : null;
  }
  async upsertVerifiedPurchase(input: Record<string, unknown> & { purchaseToken: string; userId: string }) {
    const existing = this.purchases.get(input.purchaseToken);
    if (existing && existing.userId !== input.userId) {
      throw new PurchaseOwnershipError(input.purchaseToken, existing.userId, input.userId);
    }
    const row = {
      ...(existing ?? { id: randomUUID(), createdAt: new Date() }),
      ...input,
      userId: existing ? existing.userId : input.userId,
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
  async setPurchaseState(id: string, state: SubscriptionState) {
    const token = this.byId.get(id);
    if (token) this.purchases.set(token, { ...this.purchases.get(token)!, state });
    return {};
  }
  async listUnacknowledgedPurchases(limit: number) {
    return [...this.purchases.values()]
      .filter(
        (p) =>
          !p.acknowledged &&
          ([SubscriptionState.ACTIVE, SubscriptionState.CANCELED, SubscriptionState.IN_GRACE_PERIOD] as SubscriptionState[]).includes(
            p.state,
          ),
      )
      .slice(0, limit);
  }
  async listReconcilablePurchases(limit: number) {
    return [...this.purchases.values()]
      .filter((p) => !([SubscriptionState.EXPIRED, SubscriptionState.REVOKED] as SubscriptionState[]).includes(p.state))
      .slice(0, limit);
  }
  async countUnacknowledged() {
    return [...this.purchases.values()].filter(
      (p) =>
        !p.acknowledged &&
        ([SubscriptionState.ACTIVE, SubscriptionState.CANCELED, SubscriptionState.IN_GRACE_PERIOD] as SubscriptionState[]).includes(
          p.state,
        ),
    ).length;
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
    const row = { id: randomUUID(), startsAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...input } as unknown as UserEntitlement;
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

// ── Fake Google ────────────────────────────────────────────────────────────────
class FakeGoogle implements GooglePlayClient {
  isConfigured = true;
  ackCalls = 0;
  private subs = new Map<string, NormalizedSubscription>();
  private invalid = new Set<string>();
  setSub(token: string, sub: NormalizedSubscription) {
    this.subs.set(token, sub);
    this.invalid.delete(token);
  }
  setInvalid(token: string) {
    this.invalid.add(token);
  }
  async getSubscription(token: string): Promise<NormalizedSubscription> {
    if (this.invalid.has(token) || !this.subs.has(token)) throw new InvalidPurchaseTokenError();
    return this.subs.get(token)!;
  }
  async acknowledgeSubscription(): Promise<void> {
    this.ackCalls += 1;
  }
}

const fakePrisma = { $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}) } as never;

function sub(overrides: Partial<NormalizedSubscription> = {}): NormalizedSubscription {
  return {
    productId: SETTLIO_PREMIUM_MONTHLY,
    state: SubscriptionState.ACTIVE,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    autoRenewing: true,
    acknowledged: true,
    orderId: 'GPA.1',
    purchasedAt: new Date(),
    linkedPurchaseToken: null,
    raw: { fake: true },
    ...overrides,
  };
}

function pushMsg(notif: object, messageId: string) {
  return { data: Buffer.from(JSON.stringify(notif)).toString('base64'), messageId };
}
const subNotif = (type: number, token: string) => ({
  subscriptionNotification: { notificationType: type, purchaseToken: token, subscriptionId: SETTLIO_PREMIUM_MONTHLY },
});
const voidedNotif = (token: string) => ({ voidedPurchaseNotification: { purchaseToken: token } });

function build() {
  const repo = new FakeRepo();
  const cast = repo as unknown as EntitlementRepository;
  const ents = new EntitlementService(fakePrisma, cast);
  const verification = new VerificationService(fakePrisma, cast, ents, googleRef.g);
  const rtdn = new RtdnService(cast, verification);
  const reconciliation = new ReconciliationService(cast, verification, googleRef.g);
  return { repo, verification, rtdn, reconciliation };
}
const googleRef = { g: new FakeGoogle() };

async function activeExpiry(repo: FakeRepo, userId: string): Promise<Date | null> {
  const e = await repo.findActiveEntitlement(userId, 'PREMIUM');
  return e ? e.expiresAt : null;
}

async function main(): Promise<void> {
  const google = new FakeGoogle();
  googleRef.g = google;
  const { repo, verification, rtdn, reconciliation } = build();

  const userA = randomUUID();
  const userB = randomUUID();
  const tokenA = `tok_${randomUUID()}`;

  // Seed: verify an active subscription.
  const T1 = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  google.setSub(tokenA, sub({ expiresAt: T1 }));
  const v = await verification.verify(userA, tokenA);
  assert.equal(v.isPremium, true, 'seed: active sub → premium');
  console.log('✓ seeded active subscription');

  // 9. Replay protection still intact.
  await assert.rejects(
    () => verification.verify(userB, tokenA),
    (e: unknown) => e instanceof ApiError && e.statusCode === 409,
    'cross-user reuse must 409',
  );
  console.log('✓ replay protection intact (cross-user 409)');

  // 2. Renewal extends entitlement.
  const T2 = new Date(T1.getTime() + 30 * 24 * 3600 * 1000);
  google.setSub(tokenA, sub({ expiresAt: T2 }));
  const r1 = await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.RENEWED, tokenA), 'msg-renew-1'));
  assert.equal(r1.status, 'processed', 'renewal processed');
  assert.equal((await activeExpiry(repo, userA))?.getTime(), T2.getTime(), 'entitlement expiry extended to T2');
  console.log('✓ renewal extends entitlement');

  // 1. Duplicate RTDN ignored (same messageId).
  const dup = await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.RENEWED, tokenA), 'msg-renew-1'));
  assert.equal(dup.status, 'duplicate', 'duplicate messageId ignored');
  console.log('✓ duplicate RTDN safely ignored');

  // 3. Cancellation stays entitled until expiry.
  google.setSub(tokenA, sub({ state: SubscriptionState.CANCELED, expiresAt: T2 }));
  await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.CANCELED, tokenA), 'msg-cancel-1'));
  assert.ok(await repo.findActiveEntitlement(userA, 'PREMIUM'), 'canceled-but-unexpired stays entitled');
  console.log('✓ cancellation stays entitled until expiry');

  // 6. Out-of-order: a stale EXPIRED notification arrives, but Google truth is
  //    still ACTIVE (T2) → re-fetch wins, entitlement NOT downgraded.
  google.setSub(tokenA, sub({ state: SubscriptionState.ACTIVE, expiresAt: T2 }));
  await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.EXPIRED, tokenA), 'msg-stale-expired'));
  assert.equal((await activeExpiry(repo, userA))?.getTime(), T2.getTime(), 'stale event did not corrupt state');
  console.log('✓ out-of-order event does not corrupt state (Google truth wins)');

  // 7. Reconciliation repairs drift: Google renewed to T3 but no RTDN arrived.
  const T3 = new Date(T2.getTime() + 30 * 24 * 3600 * 1000);
  google.setSub(tokenA, sub({ expiresAt: T3 }));
  const sweep = await reconciliation.runReconciliationSweep(50);
  assert.ok(sweep.reconciled >= 1, 'sweep reconciled at least one');
  assert.equal((await activeExpiry(repo, userA))?.getTime(), T3.getTime(), 'drift repaired to T3');
  console.log('✓ reconciliation sweep repairs drift');

  // 8. Acknowledgment recovery: simulate a prior failed ack (acknowledged=false),
  //    Google still reports not acknowledged → sweep re-acks. Uses its own user
  //    (one premium subscription per user is the realistic shape).
  const userC = randomUUID();
  const tokenC = `tok_${randomUUID()}`;
  google.setSub(tokenC, sub({ acknowledged: false }));
  await verification.verify(userC, tokenC); // acks inline (ackCalls++) and persists ack=true
  // Force the drift: pretend the persisted ack didn't stick and Google still says unacked.
  repo.purchases.set(tokenC, { ...repo.purchases.get(tokenC)!, acknowledged: false });
  google.setSub(tokenC, sub({ acknowledged: false }));
  const ackBefore = google.ackCalls;
  const ackSweep = await reconciliation.runAcknowledgementSweep(50);
  assert.ok(ackSweep.reconciled >= 1, 'ack sweep processed the unacked purchase');
  assert.ok(google.ackCalls > ackBefore, 'sweep re-acknowledged');
  assert.equal(repo.purchases.get(tokenC)?.acknowledged, true, 'ack persisted after sweep');
  console.log('✓ acknowledgment sweep recovers a failed ack');

  // 4. Refund (voided) revokes immediately.
  await rtdn.processPushMessage(pushMsg(voidedNotif(tokenA), 'msg-voided-1'));
  assert.ok(!(await repo.findActiveEntitlement(userA, 'PREMIUM')), 'refund revokes entitlement');
  assert.equal(repo.purchases.get(tokenA)?.state, SubscriptionState.REVOKED, 'purchase marked REVOKED');
  console.log('✓ refund / voided purchase revokes entitlement immediately');

  // 5. Expired subscription loses entitlement (Google drops the token).
  const tokenE = `tok_${randomUUID()}`;
  const userE = randomUUID();
  google.setSub(tokenE, sub());
  await verification.verify(userE, tokenE);
  assert.ok(await repo.findActiveEntitlement(userE, 'PREMIUM'), 'userE premium before expiry');
  google.setInvalid(tokenE); // Google no longer recognizes it → gone
  await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.EXPIRED, tokenE), 'msg-expired-e'));
  assert.ok(!(await repo.findActiveEntitlement(userE, 'PREMIUM')), 'expired sub loses entitlement');
  assert.equal(repo.purchases.get(tokenE)?.state, SubscriptionState.EXPIRED, 'purchase marked EXPIRED');
  console.log('✓ expired subscription loses entitlement');

  console.log('\nAll RTDN / reconciliation / acknowledgment checks passed ✅');
}

main().catch((err: unknown) => {
  console.error('✗ rtdn smoke failed:', err);
  process.exit(1);
});
