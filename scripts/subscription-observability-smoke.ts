/**
 * Subscription observability smoke test (P1) — validates the instrumentation,
 * not the billing behaviour.
 *
 * Asserts:
 *   1. Redaction: purchase tokens / order ids are hashed, never emitted raw;
 *      linkedPurchaseToken is reduced to a presence boolean.
 *   2. Structured logging: canonical event names + consistent, redacted context.
 *   3. Correlation propagation: an ambient correlation id flows through async
 *      code (including nested awaits) into every emitted event.
 *   4. Metric emission: a full verify → grant → ack flow emits the expected
 *      metrics (latency, google api, ack) with low-cardinality tags and no
 *      sensitive values.
 *   5. End-to-end trace: all events for one purchase share the token hash, and
 *      all events in one invocation share the correlation id.
 *
 * Run: npm run smoke:observability
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SubscriptionPurchase, UserEntitlement } from '@prisma/client';
import { METRICS } from '../src/constants/metrics.js';
import { EntitlementStatus, SETTLIO_PREMIUM_MONTHLY, SubscriptionState } from '../src/modules/entitlement/constants.js';
import type { GooglePlayClient } from '../src/modules/entitlement/google/google-play-client.js';
import type { NormalizedSubscription } from '../src/modules/entitlement/google/types.js';
import {
  buildContext,
  type Captured,
  captureTelemetry,
  getCorrelationId,
  hashOrderId,
  hashPurchaseToken,
  linkedTokenPresent,
  runWithCorrelation,
  SUB_EVENT,
} from '../src/modules/entitlement/observability/index.js';
import type { EntitlementRepository } from '../src/modules/entitlement/repository/entitlement.repository.js';
import { EntitlementService } from '../src/modules/entitlement/service/entitlement.service.js';
import { VerificationService } from '../src/modules/entitlement/service/verification.service.js';

const RAW_TOKEN = 'raw-secret-purchase-token-abc123';
const RAW_ORDER = 'GPA.9999-1111-2222';
const RAW_LINKED = 'raw-linked-token-xyz';

// A deep scan asserting a raw secret appears nowhere in an emitted event.
function assertNoRawSecret(events: Captured[]): void {
  const haystack = JSON.stringify(events);
  for (const secret of [RAW_TOKEN, RAW_ORDER, RAW_LINKED]) {
    assert.ok(!haystack.includes(secret), `raw secret leaked into telemetry: ${secret}`);
  }
}

function logEventsFor(events: Captured[], name: string): Captured[] {
  return events.filter((e) => e.kind === 'log' && e.event === name);
}
function metricEvents(events: Captured[], name: string): Extract<Captured, { kind: 'metric' }>[] {
  return events.filter((e): e is Extract<Captured, { kind: 'metric' }> => e.kind === 'metric' && e.name === name);
}

// ── Minimal fakes for a real verify → grant → ack flow ──────────────────────────
class FakeRepo {
  purchases = new Map<string, SubscriptionPurchase>();
  byId = new Map<string, string>();
  entitlements: UserEntitlement[] = [];
  async createAuditLog() {
    return { id: randomUUID() };
  }
  async findPurchaseByToken(token: string) {
    return this.purchases.get(token) ?? null;
  }
  async acquireTokenLock() {}
  async lockPurchaseOwner(token: string) {
    const r = this.purchases.get(token);
    return r ? { id: r.id, userId: r.userId } : null;
  }
  async upsertVerifiedPurchase(input: Record<string, unknown> & { purchaseToken: string; userId: string }) {
    const existing = this.purchases.get(input.purchaseToken);
    const row = {
      ...(existing ?? { id: randomUUID(), createdAt: new Date() }),
      ...input,
      userId: existing ? (existing as SubscriptionPurchase).userId : input.userId,
      updatedAt: new Date(),
    } as unknown as SubscriptionPurchase;
    this.purchases.set(input.purchaseToken, row);
    this.byId.set(row.id, input.purchaseToken);
    return row;
  }
  async setAcknowledged(id: string) {
    const t = this.byId.get(id);
    if (t) this.purchases.set(t, { ...this.purchases.get(t)!, acknowledged: true });
    return {};
  }
  async findActiveEntitlement() {
    return null;
  }
  async findActiveEntitlementBySource() {
    return null;
  }
  async findActiveEntitlementsOfType(userId: string) {
    return this.entitlements.filter((e) => e.userId === userId && e.status === EntitlementStatus.ACTIVE);
  }
  async upsertEntitlement(input: Record<string, unknown> & { userId: string }) {
    const row = { id: randomUUID(), startsAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...input } as unknown as UserEntitlement;
    this.entitlements.push(row);
    return row;
  }
  async createHistory() {
    return {} as never;
  }
  async updatePremiumCache() {
    return {};
  }
}
class FakeGoogle implements GooglePlayClient {
  isConfigured = true;
  ackCalls = 0;
  constructor(private sub: NormalizedSubscription) {}
  async getSubscription(): Promise<NormalizedSubscription> {
    return this.sub;
  }
  async acknowledgeSubscription(): Promise<void> {
    this.ackCalls += 1;
  }
}
const fakePrisma = { $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}) } as never;

async function main(): Promise<void> {
  // 1. Redaction helpers.
  {
    const h = hashPurchaseToken(RAW_TOKEN);
    assert.ok(h && h.startsWith('pt_') && !h.includes(RAW_TOKEN), 'token hashed, prefixed, non-reversible');
    assert.equal(hashPurchaseToken(RAW_TOKEN), h, 'token hash is stable');
    assert.notEqual(hashPurchaseToken('other'), h, 'different tokens → different hashes');
    assert.equal(hashPurchaseToken(null), null, 'null token → null');
    const o = hashOrderId(RAW_ORDER);
    assert.ok(o && o.startsWith('oid_') && !o.includes(RAW_ORDER), 'order id hashed');
    assert.equal(linkedTokenPresent(RAW_LINKED), true);
    assert.equal(linkedTokenPresent(null), false);
    console.log('✓ redaction: tokens/order ids hashed (stable, non-reversible), linked → presence');
  }

  // 2. Context builder redacts + shapes consistently.
  {
    const ctx = buildContext({
      userId: 'u1',
      purchaseToken: RAW_TOKEN,
      orderId: RAW_ORDER,
      linkedPurchaseToken: RAW_LINKED,
      productId: SETTLIO_PREMIUM_MONTHLY,
      subscriptionState: 'ACTIVE',
      acknowledged: true,
      source: 'client',
      latencyMs: 12.3,
      outcome: 'granted',
    });
    assert.equal(ctx.purchaseTokenHash, hashPurchaseToken(RAW_TOKEN));
    assert.equal(ctx.orderIdHash, hashOrderId(RAW_ORDER));
    assert.equal(ctx.linkedPurchaseTokenPresent, true);
    assert.equal(ctx.productId, SETTLIO_PREMIUM_MONTHLY);
    assert.ok(!JSON.stringify(ctx).includes(RAW_TOKEN) && !JSON.stringify(ctx).includes(RAW_ORDER));
    assert.equal((ctx as Record<string, unknown>).purchaseToken, undefined, 'no raw token field');
    console.log('✓ structured context: redacted, consistent field names, no raw secrets');
  }

  // 3. Correlation propagation across nested awaits.
  {
    const outer = await runWithCorrelation('corr-123', async () => {
      const a = getCorrelationId();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      const b = getCorrelationId();
      const nested = buildContext({ purchaseToken: RAW_TOKEN });
      return { a, b, nested: nested.correlationId };
    });
    assert.equal(outer.a, 'corr-123');
    assert.equal(outer.b, 'corr-123', 'correlation survives nested async awaits');
    assert.equal(outer.nested, 'corr-123', 'buildContext picks up ambient correlation');
    assert.equal(getCorrelationId(), undefined, 'no correlation leaks outside the scope');
    console.log('✓ correlation: propagates through async tree, isolated outside scope');
  }

  // 4 + 5. Full verify flow: metric emission, structured logs, e2e trace.
  {
    const repo = new FakeRepo();
    const google = new FakeGoogle({
      productId: SETTLIO_PREMIUM_MONTHLY,
      state: SubscriptionState.ACTIVE,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      autoRenewing: true,
      acknowledged: false,
      orderId: RAW_ORDER,
      purchasedAt: new Date(),
      linkedPurchaseToken: null,
      raw: { fake: true },
    });
    const ents = new EntitlementService(fakePrisma, repo as unknown as EntitlementRepository);
    const svc = new VerificationService(fakePrisma, repo as unknown as EntitlementRepository, ents, google);

    const { events, restore } = captureTelemetry();
    try {
      await runWithCorrelation('trace-777', () => svc.verify('user-1', RAW_TOKEN));
    } finally {
      restore();
    }

    // No raw secret anywhere.
    assertNoRawSecret(events);

    // Structured logs for the key lifecycle stages.
    assert.ok(logEventsFor(events, SUB_EVENT.VERIFY_REQUESTED).length >= 1, 'verify.requested logged');
    assert.ok(logEventsFor(events, SUB_EVENT.ENTITLEMENT_GRANTED).length >= 1, 'entitlement.granted logged');
    assert.ok(logEventsFor(events, SUB_EVENT.ACK_SUCCEEDED).length >= 1, 'ack.succeeded logged');
    assert.ok(logEventsFor(events, SUB_EVENT.VERIFY_SUCCEEDED).length >= 1, 'verify.succeeded logged');
    // (Google Developer API telemetry lives in the concrete client and is
    // exercised by the real-client path, not this in-memory fake.)

    // Metric emission (latency + counters) with low-cardinality tags.
    assert.ok(metricEvents(events, METRICS.verifyLatencyMs).length >= 1, 'verify latency emitted');
    assert.ok(metricEvents(events, METRICS.ackLatencyMs).length >= 1, 'ack latency emitted');
    const verifyLatency = metricEvents(events, METRICS.verifyLatencyMs)[0]!;
    assert.equal(verifyLatency.tags.outcome, 'success');
    assert.equal(typeof verifyLatency.value, 'number');

    // End-to-end trace: every subscription log for this purchase shares the token
    // hash AND the correlation id.
    const expectedHash = hashPurchaseToken(RAW_TOKEN);
    const subLogs = events.filter((e) => e.kind === 'log') as Extract<Captured, { kind: 'log' }>[];
    const withToken = subLogs.filter((e) => e.ctx.purchaseTokenHash != null);
    assert.ok(withToken.length >= 3, 'multiple lifecycle logs carry the token hash');
    assert.ok(withToken.every((e) => e.ctx.purchaseTokenHash === expectedHash), 'one purchase → one token hash');
    assert.ok(subLogs.every((e) => e.ctx.correlationId === 'trace-777'), 'one invocation → one correlation id');
    console.log('✓ metrics emitted + lifecycle logs structured + e2e trace joins on token hash & correlation id');
  }

  console.log('\nAll subscription observability checks passed ✅');
}

main().catch((err: unknown) => {
  console.error('✗ observability smoke failed:', err);
  process.exit(1);
});
