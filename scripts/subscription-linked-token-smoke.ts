/**
 * linkedPurchaseToken chain-migration smoke test (P1) — DB-free, network-free.
 *
 * Google issues a NEW purchase token on upgrade / downgrade / resubscribe /
 * token replacement, carrying `linkedPurchaseToken` → the previous token. This
 * suite proves the subscription stays attached to the SAME user across the whole
 * chain, that exactly ONE entitlement is ever active per chain, that ownership
 * cannot change during migration, and that history/audit are preserved.
 *
 * Scenarios:
 *   1. Upgrade (client verify migrates onto the new token).
 *   2. Downgrade (same, shorter plan).
 *   3. Resubscribe after cancellation (migrate off an EXPIRED parent).
 *   4. Token replacement via RTDN (Play-initiated, no client — owner inherited).
 *   5. Unknown linked token: RTDN → unattributable; client verify → attributed to requester.
 *   6. Duplicate RTDN delivery → deduped, idempotent.
 *   7. Out-of-order events: a late old-token event never disturbs the successor.
 *   8. Reconciliation sweep after migration → idempotent, one active entitlement.
 *
 * Run: npm run smoke:verify-linked
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

// ── Fake repo (single in-memory store; ignores the tx arg — sequential) ─────────
class FakeRepo {
  purchases = new Map<string, SubscriptionPurchase>(); // by token
  byId = new Map<string, string>(); // id → token
  entitlements: UserEntitlement[] = [];
  history: unknown[] = [];
  auditByMessageId = new Map<string, unknown>();
  audit: { eventType: string; processedOk: boolean; payload?: unknown }[] = [];
  premiumCache = new Map<string, { isPremium: boolean; premiumExpiresAt: Date | null }>();

  async createAuditLog(input: { eventType: string; googleMessageId?: string | null; processedOk?: boolean; payload?: unknown }) {
    const mid = input.googleMessageId;
    if (mid) {
      if (this.auditByMessageId.has(mid)) {
        throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
      }
      this.auditByMessageId.set(mid, input);
    }
    this.audit.push({ eventType: input.eventType, processedOk: input.processedOk ?? true, payload: input.payload });
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
  async listReconcilablePurchases(limit: number) {
    return [...this.purchases.values()]
      .filter((p) => !([SubscriptionState.EXPIRED, SubscriptionState.REVOKED] as SubscriptionState[]).includes(p.state))
      .slice(0, limit);
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
  async countUnacknowledged() {
    return 0;
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

  // ── Test assertions helpers ──
  activePremium(userId: string): UserEntitlement[] {
    const now = new Date();
    return this.entitlements.filter(
      (e) => e.userId === userId && e.entitlement === 'PREMIUM' && e.status === EntitlementStatus.ACTIVE && (e.expiresAt === null || e.expiresAt > now),
    );
  }
}

// ── Fake Google (keyed by token; supports link chains + invalidation) ───────────
class FakeGoogle implements GooglePlayClient {
  isConfigured = true;
  ackCalls = 0;
  private subs = new Map<string, NormalizedSubscription>();
  private invalid = new Set<string>();
  setSub(token: string, s: NormalizedSubscription) {
    this.subs.set(token, s);
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

function build() {
  const repo = new FakeRepo();
  const google = new FakeGoogle();
  const cast = repo as unknown as EntitlementRepository;
  const ents = new EntitlementService(fakePrisma, cast);
  const verification = new VerificationService(fakePrisma, cast, ents, google);
  const rtdn = new RtdnService(cast, verification);
  const reconciliation = new ReconciliationService(cast, verification, google);
  return { repo, google, verification, rtdn, reconciliation };
}

function pushMsg(notif: object, messageId: string) {
  return { data: Buffer.from(JSON.stringify(notif)).toString('base64'), messageId };
}
const subNotif = (type: number, token: string) => ({
  subscriptionNotification: { notificationType: type, purchaseToken: token, subscriptionId: SETTLIO_PREMIUM_MONTHLY },
});
const voidedNotif = (token: string) => ({ voidedPurchaseNotification: { purchaseToken: token } });

const days = (n: number) => new Date(Date.now() + n * 24 * 3600 * 1000);

async function main(): Promise<void> {
  // 1. UPGRADE — client verifies the new token; subscription migrates forward.
  {
    const { repo, google, verification } = build();
    const user = randomUUID();
    const tok1 = 'up_tok1';
    const tok2 = 'up_tok2';
    google.setSub(tok1, sub({ expiresAt: days(30), orderId: 'GPA.A' }));
    await verification.verify(user, tok1);
    const row1 = repo.purchases.get(tok1)!;

    google.setSub(tok2, sub({ expiresAt: days(365), orderId: 'GPA.B', linkedPurchaseToken: tok1 }));
    const res = await verification.verify(user, tok2);

    assert.equal(res.isPremium, true, 'upgrade: still premium');
    const active = repo.activePremium(user);
    assert.equal(active.length, 1, 'exactly one active entitlement after upgrade');
    assert.equal(active[0]!.sourceRef, repo.purchases.get(tok2)!.id, 'active entitlement is the NEW token');
    assert.equal(repo.purchases.get(tok2)!.userId, user, 'ownership preserved on new token');
    assert.equal(repo.purchases.get(tok1)!.state, SubscriptionState.EXPIRED, 'old token marked terminal');
    assert.ok(
      repo.entitlements.some((e) => e.sourceRef === row1.id && e.status === EntitlementStatus.EXPIRED),
      'predecessor entitlement closed',
    );
    assert.equal(
      repo.premiumCache.get(user)?.premiumExpiresAt?.getTime(),
      repo.purchases.get(tok2)!.expiresAt?.getTime(),
      'premium expiry advanced to the new token',
    );
    assert.equal(repo.purchases.size, 2, 'both purchase rows preserved (history)');
    console.log('✓ upgrade: migrated to new token, one active entitlement, ownership + history preserved');
  }

  // 2. DOWNGRADE — same migration mechanics with a shorter successor plan.
  {
    const { repo, google, verification } = build();
    const user = randomUUID();
    google.setSub('dn_1', sub({ expiresAt: days(365), orderId: 'GPA.YEAR' }));
    await verification.verify(user, 'dn_1');
    google.setSub('dn_2', sub({ expiresAt: days(30), orderId: 'GPA.MONTH', linkedPurchaseToken: 'dn_1' }));
    const res = await verification.verify(user, 'dn_2');
    assert.equal(res.isPremium, true, 'downgrade: still premium');
    assert.equal(repo.activePremium(user).length, 1, 'one active entitlement after downgrade');
    assert.equal(repo.activePremium(user)[0]!.sourceRef, repo.purchases.get('dn_2')!.id, 'active is the downgraded token');
    assert.equal(repo.purchases.get('dn_1')!.state, SubscriptionState.EXPIRED, 'old token terminal');
    console.log('✓ downgrade: migrated to new token, single active entitlement');
  }

  // 3. RESUBSCRIBE AFTER CANCELLATION — migrate off an EXPIRED parent token.
  {
    const { repo, google, verification } = build();
    const user = randomUUID();
    google.setSub('rs_1', sub({ expiresAt: days(30) }));
    await verification.verify(user, 'rs_1');
    // Cancel + lapse: parent expires.
    google.setSub('rs_1', sub({ state: SubscriptionState.EXPIRED, expiresAt: days(-1) }));
    await verification.verify(user, 'rs_1');
    assert.equal(repo.activePremium(user).length, 0, 'no premium after lapse');
    // Resubscribe → new token linked to the (expired) parent.
    google.setSub('rs_2', sub({ expiresAt: days(30), orderId: 'GPA.RESUB', linkedPurchaseToken: 'rs_1' }));
    const res = await verification.verify(user, 'rs_2');
    assert.equal(res.isPremium, true, 'resubscribe restores premium');
    assert.equal(repo.activePremium(user).length, 1, 'one active entitlement after resubscribe');
    assert.equal(repo.activePremium(user)[0]!.sourceRef, repo.purchases.get('rs_2')!.id, 'active is the resubscribe token');
    assert.equal(repo.purchases.get('rs_2')!.userId, user, 'ownership preserved across resubscribe (expired parent)');
    console.log('✓ resubscribe after cancellation: migrated off expired parent, ownership preserved');
  }

  // 4. TOKEN REPLACEMENT via RTDN — Play-initiated, no client; owner inherited.
  {
    const { repo, google, rtdn, verification } = build();
    const user = randomUUID();
    google.setSub('rp_1', sub({ expiresAt: days(30) }));
    // Seed the original subscription, then let a Play-initiated RTDN (no client)
    // replace the token.
    await verification.verify(user, 'rp_1');
    google.setSub('rp_2', sub({ expiresAt: days(60), orderId: 'GPA.REPL', linkedPurchaseToken: 'rp_1' }));
    const out = await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.PURCHASED, 'rp_2'), 'mid-rp-1'));
    assert.equal(out.status, 'processed', 'RTDN for a new linked token migrates (processed)');
    assert.equal(repo.activePremium(user).length, 1, 'one active entitlement after RTDN replacement');
    assert.equal(repo.activePremium(user)[0]!.sourceRef, repo.purchases.get('rp_2')!.id, 'active is the replacement token');
    assert.equal(repo.purchases.get('rp_2')!.userId, user, 'owner inherited from the chain (RTDN never invents an owner)');
    assert.equal(repo.purchases.get('rp_1')!.state, SubscriptionState.EXPIRED, 'replaced token terminal');
    console.log('✓ token replacement via RTDN: migrated, owner inherited, one active entitlement');
  }

  // 5. UNKNOWN LINKED TOKEN — RTDN unattributable; client verify attributes to requester.
  {
    const { repo, google, rtdn, verification } = build();
    const user = randomUUID();
    // (a) RTDN for a new token whose linked predecessor was never seen.
    google.setSub('ul_new', sub({ expiresAt: days(30), linkedPurchaseToken: 'ul_ghost' }));
    const out = await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.PURCHASED, 'ul_new'), 'mid-ul-1'));
    assert.equal(out.status, 'unknown_purchase', 'RTDN with unknown linked predecessor is unattributable');
    assert.equal(repo.purchases.size, 0, 'no purchase row created for an unattributable RTDN');
    assert.equal(repo.entitlements.length, 0, 'no entitlement created');
    // (b) A client verify of the same token attributes it to the authenticated user.
    const res = await verification.verify(user, 'ul_new');
    assert.equal(res.isPremium, true, 'client verify attributes an unknown-linked token to the requester');
    assert.equal(repo.purchases.get('ul_new')!.userId, user, 'owner = requester (no predecessor to inherit from)');
    assert.equal(repo.activePremium(user).length, 1, 'one active entitlement');
    console.log('✓ unknown linked token: RTDN unattributable (no-op); client verify attributes to requester');
  }

  // 6. DUPLICATE RTDN DELIVERY — deduped + idempotent.
  {
    const { repo, google, rtdn, verification } = build();
    const user = randomUUID();
    google.setSub('dp_1', sub({ expiresAt: days(30) }));
    await verification.verify(user, 'dp_1');
    google.setSub('dp_2', sub({ expiresAt: days(60), linkedPurchaseToken: 'dp_1' }));
    const first = await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.PURCHASED, 'dp_2'), 'mid-dup'));
    assert.equal(first.status, 'processed', 'first delivery migrates');
    // Same messageId again → dedup.
    const dupe = await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.PURCHASED, 'dp_2'), 'mid-dup'));
    assert.equal(dupe.status, 'duplicate', 'duplicate messageId is a no-op');
    // A fresh messageId for the now-known token → normal idempotent reconcile.
    const again = await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.RENEWED, 'dp_2'), 'mid-dup-2'));
    assert.equal(again.status, 'processed', 'later event for the migrated token reconciles');
    assert.equal(repo.activePremium(user).length, 1, 'still exactly one active entitlement after duplicates');
    console.log('✓ duplicate RTDN delivery: deduped and idempotent (one active entitlement)');
  }

  // 7. OUT-OF-ORDER EVENTS — a late old-token event must not disturb the successor.
  {
    const { repo, google, rtdn, verification } = build();
    const user = randomUUID();
    google.setSub('oo_1', sub({ expiresAt: days(30) }));
    await verification.verify(user, 'oo_1');
    google.setSub('oo_2', sub({ expiresAt: days(60), linkedPurchaseToken: 'oo_1' }));
    await verification.verify(user, 'oo_2'); // migrate
    const activeAfterMigrate = repo.activePremium(user);
    assert.equal(activeAfterMigrate.length, 1, 'one active after migration');
    const newSourceRef = activeAfterMigrate[0]!.sourceRef;

    // Late CANCELED/EXPIRED for the OLD token (Google reports it gone).
    google.setInvalid('oo_1');
    const late = await rtdn.processPushMessage(pushMsg(subNotif(SUB_NOTIFICATION.EXPIRED, 'oo_1'), 'mid-oo-late'));
    assert.equal(late.status, 'processed', 'late old-token event is processed');

    // Late refund/void for the OLD token too.
    await rtdn.processPushMessage(pushMsg(voidedNotif('oo_1'), 'mid-oo-void'));

    const activeNow = repo.activePremium(user);
    assert.equal(activeNow.length, 1, 'successor entitlement untouched by old-token events');
    assert.equal(activeNow[0]!.sourceRef, newSourceRef, 'still the successor entitlement');
    assert.equal(repo.premiumCache.get(user)?.isPremium, true, 'premium retained through out-of-order old-token events');
    console.log('✓ out-of-order events: late old-token expiry/void never disturbs the successor');
  }

  // 8. RECONCILIATION AFTER MIGRATION — sweep is idempotent, one active entitlement.
  {
    const { repo, google, verification, reconciliation } = build();
    const user = randomUUID();
    google.setSub('rc_1', sub({ expiresAt: days(30) }));
    await verification.verify(user, 'rc_1');
    google.setSub('rc_2', sub({ expiresAt: days(60), linkedPurchaseToken: 'rc_1' }));
    await verification.verify(user, 'rc_2'); // migrate

    const summary = await reconciliation.runReconciliationSweep();
    // Only the ACTIVE successor is reconcilable; the EXPIRED predecessor is skipped.
    assert.equal(summary.scanned, 1, 'sweep scans only the non-terminal successor');
    assert.equal(summary.reconciled, 1, 'successor reconciled');
    assert.equal(repo.activePremium(user).length, 1, 'still one active entitlement after sweep');
    assert.equal(repo.activePremium(user)[0]!.sourceRef, repo.purchases.get('rc_2')!.id, 'sweep keeps the successor active');
    assert.equal(repo.purchases.get('rc_1')!.state, SubscriptionState.EXPIRED, 'predecessor stays terminal');
    assert.equal(repo.premiumCache.get(user)?.isPremium, true, 'premium retained after reconciliation');
    console.log('✓ reconciliation after migration: idempotent, single active entitlement retained');
  }

  // Cross-account safety during migration: a DIFFERENT user cannot claim the chain.
  {
    const { google, verification } = build();
    const owner = randomUUID();
    const attacker = randomUUID();
    google.setSub('xa_1', sub({ expiresAt: days(30) }));
    await verification.verify(owner, 'xa_1');
    google.setSub('xa_2', sub({ expiresAt: days(60), linkedPurchaseToken: 'xa_1' }));
    await assert.rejects(
      () => verification.verify(attacker, 'xa_2'),
      (e: unknown) => e instanceof ApiError && e.statusCode === 409,
      'a different user cannot migrate/claim another account’s chain',
    );
    console.log('✓ ownership immutable during migration: foreign claim on the chain 409s');
  }

  console.log('\nAll linkedPurchaseToken chain-migration checks passed ✅');
}

main().catch((err: unknown) => {
  console.error('✗ linked-token smoke failed:', err);
  process.exit(1);
});
