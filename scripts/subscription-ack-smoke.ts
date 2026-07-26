/**
 * Backend-owned acknowledgement lifecycle smoke test (P1) — DB-free, network-free.
 *
 * The backend is the EXCLUSIVE owner of Google Play acknowledgement. This suite
 * proves the ack is exactly-once, idempotent, durable, and never leads to the
 * 3-day auto-refund under any ordering. The fake models Postgres advisory-lock
 * semantics (a real per-token mutex held for the transaction) so concurrency is
 * genuinely serialized, and a FakeGoogle that tracks ack calls + reflects the
 * acknowledged state back on the next fetch.
 *
 * Scenarios:
 *   1. Successful acknowledgement.
 *   2. Already-acknowledged purchase (no ack call).
 *   3. Acknowledgement failure → durable retry via the ack sweep.
 *   4. Duplicate verification requests (single ack, idempotent).
 *   5. Concurrent verification (single ack under a real race).
 *   6. Server restart before ack (fresh instances + shared store → sweep acks).
 *   7. Replayed RTDN events (deduped; no re-acknowledgement).
 *   8. Reconciliation acknowledging a previously missed purchase.
 *
 * Run: npm run smoke:verify-ack
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma, type SubscriptionPurchase, type UserEntitlement } from '@prisma/client';
import { EntitlementStatus, SETTLIO_PREMIUM_MONTHLY, SubscriptionState } from '../src/modules/entitlement/constants.js';
import type { GooglePlayClient } from '../src/modules/entitlement/google/google-play-client.js';
import { SUB_NOTIFICATION } from '../src/modules/entitlement/google/rtdn-types.js';
import { InvalidPurchaseTokenError, type NormalizedSubscription } from '../src/modules/entitlement/google/types.js';
import { type EntitlementRepository, PurchaseOwnershipError } from '../src/modules/entitlement/repository/entitlement.repository.js';
import { EntitlementService } from '../src/modules/entitlement/service/entitlement.service.js';
import { ReconciliationService } from '../src/modules/entitlement/service/reconciliation.service.js';
import { RtdnService } from '../src/modules/entitlement/service/rtdn.service.js';
import { VerificationService } from '../src/modules/entitlement/service/verification.service.js';

interface TxCtx {
  releases: Array<() => void>;
}

/** Fake that is BOTH the Prisma client and the repository (persistent store). */
class FakeDb {
  purchases = new Map<string, SubscriptionPurchase>();
  byId = new Map<string, string>();
  entitlements: UserEntitlement[] = [];
  auditByMessageId = new Map<string, unknown>();
  premiumCache = new Map<string, { isPremium: boolean; premiumExpiresAt: Date | null }>();
  private tails = new Map<string, Promise<void>>();

  async $transaction<T>(fn: (tx: TxCtx) => Promise<T>): Promise<T> {
    const ctx: TxCtx = { releases: [] };
    try {
      return await fn(ctx);
    } finally {
      for (const r of ctx.releases) r();
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
    await prev;
    if (tx) tx.releases.push(release);
    else release();
  }
  async lockPurchaseOwner(token: string) {
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
      // Never downgrade a persisted ack, and keep ownership immutable.
      acknowledged: existing?.acknowledged || input.acknowledged,
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
          e.userId === userId && e.entitlement === entitlement && e.source === source && e.sourceRef === sourceRef && e.status === EntitlementStatus.ACTIVE,
      ) ?? null
    );
  }
  async findActiveEntitlementsOfType(userId: string, entitlement: string, now = new Date()) {
    return this.entitlements.filter(
      (e) => e.userId === userId && e.entitlement === entitlement && e.status === EntitlementStatus.ACTIVE && (e.expiresAt === null || e.expiresAt > now),
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
      (e) => e.userId === input.userId && e.entitlement === input.entitlement && e.source === input.source && e.sourceRef === input.sourceRef,
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
    return input as never;
  }
  async updatePremiumCache(userId: string, isPremium: boolean, premiumExpiresAt: Date | null) {
    this.premiumCache.set(userId, { isPremium, premiumExpiresAt });
    return {};
  }
}

/** FakeGoogle: counts ack calls, can be made to fail, reflects ack state back. */
class FakeGoogle implements GooglePlayClient {
  isConfigured = true;
  ackCalls = 0;
  failAck = false;
  private subs = new Map<string, NormalizedSubscription>();
  setSub(token: string, s: NormalizedSubscription) {
    this.subs.set(token, s);
  }
  async getSubscription(token: string): Promise<NormalizedSubscription> {
    const s = this.subs.get(token);
    if (!s) throw new InvalidPurchaseTokenError();
    return { ...s };
  }
  async acknowledgeSubscription(_productId: string, token: string): Promise<void> {
    if (this.failAck) throw new Error('google ack transient failure');
    this.ackCalls += 1;
    const s = this.subs.get(token);
    if (s) this.subs.set(token, { ...s, acknowledged: true }); // Google now reports it acked
  }
}

function activeSub(overrides: Partial<NormalizedSubscription> = {}): NormalizedSubscription {
  return {
    productId: SETTLIO_PREMIUM_MONTHLY,
    state: SubscriptionState.ACTIVE,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    autoRenewing: true,
    acknowledged: false,
    orderId: 'GPA.1',
    purchasedAt: new Date(),
    linkedPurchaseToken: null,
    raw: { fake: true },
    ...overrides,
  };
}

/** Build services over a shared store + google (pass the same to simulate restart). */
function build(db: FakeDb, google: FakeGoogle) {
  const cast = db as unknown as EntitlementRepository;
  const ents = new EntitlementService(db as never, cast);
  const verification = new VerificationService(db as never, cast, ents, google);
  const rtdn = new RtdnService(cast, verification);
  const reconciliation = new ReconciliationService(cast, verification, google);
  return { verification, rtdn, reconciliation };
}

function pushMsg(notif: object, messageId: string) {
  return { data: Buffer.from(JSON.stringify(notif)).toString('base64'), messageId };
}

async function main(): Promise<void> {
  // 1. Successful acknowledgement.
  {
    const db = new FakeDb();
    const google = new FakeGoogle();
    const { verification } = build(db, google);
    const user = randomUUID();
    google.setSub('ok', activeSub());
    const res = await verification.verify(user, 'ok');
    assert.equal(res.isPremium, true);
    assert.equal(res.acknowledged, true, 'verify reports acknowledged');
    assert.equal(google.ackCalls, 1, 'acknowledged exactly once');
    assert.equal(db.purchases.get('ok')!.acknowledged, true, 'row persisted acknowledged');
    assert.equal(db.entitlements.length, 1);
    console.log('✓ successful acknowledgement (once, persisted, reported to client)');
  }

  // 2. Already-acknowledged purchase → no ack call.
  {
    const db = new FakeDb();
    const google = new FakeGoogle();
    const { verification } = build(db, google);
    // Google already reports this purchase acknowledged.
    google.setSub('pre', activeSub({ acknowledged: true }));
    const res = await verification.verify(randomUUID(), 'pre');
    assert.equal(res.isPremium, true);
    assert.equal(res.acknowledged, true, 'reported acknowledged');
    assert.equal(google.ackCalls, 0, 'never re-acknowledges an already-acknowledged purchase');
    assert.equal(db.purchases.get('pre')!.acknowledged, true, 'row reflects acknowledged');
    console.log('✓ already-acknowledged purchase → no acknowledgement call');
  }

  // 3. Acknowledgement failure → durable retry via the sweep (grant intact).
  {
    const db = new FakeDb();
    const google = new FakeGoogle();
    const { verification, reconciliation } = build(db, google);
    const user = randomUUID();
    google.setSub('fail', activeSub());
    google.failAck = true;
    const res = await verification.verify(user, 'fail');
    assert.equal(res.isPremium, true, 'entitlement granted despite ack failure');
    assert.equal(res.acknowledged, false, 'verify reports NOT acknowledged');
    assert.equal(db.purchases.get('fail')!.acknowledged, false, 'row stays unacknowledged');
    assert.equal(db.entitlements.length, 1, 'no duplicate entitlement');

    google.failAck = false;
    const summary = await reconciliation.runAcknowledgementSweep();
    assert.equal(google.ackCalls, 1, 'sweep acknowledged exactly once');
    assert.equal(db.purchases.get('fail')!.acknowledged, true, 'now acknowledged');
    assert.equal(db.entitlements.length, 1, 'still one entitlement (no duplicate grant)');
    assert.ok(summary.reconciled >= 1);
    console.log('✓ ack failure → durable sweep retry, no duplicate entitlement');
  }

  // 4. Duplicate verification requests → single ack.
  {
    const db = new FakeDb();
    const google = new FakeGoogle();
    const { verification } = build(db, google);
    const user = randomUUID();
    google.setSub('dup', activeSub());
    await verification.verify(user, 'dup');
    await verification.verify(user, 'dup');
    await verification.verify(user, 'dup');
    assert.equal(google.ackCalls, 1, 'duplicate verifies acknowledge only once');
    assert.equal(db.entitlements.length, 1, 'one entitlement');
    assert.equal(db.purchases.size, 1, 'one purchase row');
    console.log('✓ duplicate verification requests → single acknowledgement');
  }

  // 5. Concurrent verification → single ack under a real serialized race.
  {
    const db = new FakeDb();
    const google = new FakeGoogle();
    const { verification } = build(db, google);
    const user = randomUUID();
    google.setSub('conc', activeSub());
    const [a, b] = await Promise.all([verification.verify(user, 'conc'), verification.verify(user, 'conc')]);
    assert.equal(a.isPremium && b.isPremium, true);
    assert.equal(google.ackCalls, 1, 'concurrent verifies acknowledge exactly once');
    assert.equal(db.entitlements.length, 1, 'one entitlement under concurrency');
    assert.equal(db.purchases.size, 1, 'one purchase row under concurrency');
    console.log('✓ concurrent verification → exactly one acknowledgement');
  }

  // 6. Server restart before ack → fresh instances + shared store, sweep acks.
  {
    const db = new FakeDb();
    const google = new FakeGoogle();
    const first = build(db, google);
    const user = randomUUID();
    google.setSub('restart', activeSub());
    google.failAck = true;
    await first.verification.verify(user, 'restart'); // granted, ack failed
    assert.equal(db.purchases.get('restart')!.acknowledged, false);

    // "Restart": brand-new service instances over the SAME persistent store.
    const second = build(db, google);
    google.failAck = false;
    await second.reconciliation.runAcknowledgementSweep();
    assert.equal(google.ackCalls, 1, 'post-restart sweep acknowledges the missed purchase');
    assert.equal(db.purchases.get('restart')!.acknowledged, true);
    assert.equal(db.entitlements.length, 1, 'restart did not duplicate the entitlement');
    console.log('✓ server restart before ack → new instance sweep acknowledges durably');
  }

  // 7. Replayed RTDN events → deduped, no re-acknowledgement.
  {
    const db = new FakeDb();
    const google = new FakeGoogle();
    const { verification, rtdn } = build(db, google);
    const user = randomUUID();
    google.setSub('rtdn', activeSub());
    await verification.verify(user, 'rtdn'); // acked once
    assert.equal(google.ackCalls, 1);

    const msg = pushMsg({ subscriptionNotification: { notificationType: SUB_NOTIFICATION.RENEWED, purchaseToken: 'rtdn' } }, 'mid-1');
    const first = await rtdn.processPushMessage(msg);
    assert.equal(first.status, 'processed');
    const replay = await rtdn.processPushMessage(msg); // same messageId
    assert.equal(replay.status, 'duplicate', 'replayed RTDN is deduped');
    assert.equal(google.ackCalls, 1, 'replays never re-acknowledge (already acknowledged)');
    assert.equal(db.entitlements.length, 1, 'one entitlement across RTDN replays');
    console.log('✓ replayed RTDN events → deduped, no re-acknowledgement');
  }

  // 8. Reconciliation acknowledging a previously missed purchase.
  {
    const db = new FakeDb();
    const google = new FakeGoogle();
    const { verification, reconciliation } = build(db, google);
    const user = randomUUID();
    google.setSub('missed', activeSub());
    google.failAck = true;
    await verification.verify(user, 'missed'); // missed ack
    assert.equal(await db.countUnacknowledged(), 1, 'one unacknowledged purchase pending');

    google.failAck = false;
    const summary = await reconciliation.runAcknowledgementSweep();
    assert.equal(summary.scanned, 1, 'ack sweep scanned the unacknowledged purchase');
    assert.equal(google.ackCalls, 1, 'sweep acknowledged it');
    assert.equal(await db.countUnacknowledged(), 0, 'ack backlog cleared');
    console.log('✓ reconciliation acknowledges a previously missed purchase');
  }

  console.log('\nAll backend-owned acknowledgement checks passed ✅');
}

main().catch((err: unknown) => {
  console.error('✗ acknowledgement smoke failed:', err);
  process.exit(1);
});
