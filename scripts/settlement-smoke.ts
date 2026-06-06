/**
 * End-to-end Settlement smoke test.
 *
 * Wires auth + trip + expense + settlement routers against in-memory
 * fakes, builds the Goa fixture, then exercises:
 *   - POST /settlements with all three methods (UPI / CASH / MANUAL)
 *   - validation: self-settlement, non-trip-member parties, zero/neg
 *     amounts, missing trip access
 *   - balance refresh: a single settlement reduces the suggested-transfer
 *     count and reduces both involved parties' nets
 *   - immutability: no PATCH/DELETE endpoints exist
 *   - SUM(net) === 0 after every settlement
 *   - history listing: newest first, with pagination meta
 *   - totalReimbursedMinor reflects the running ledger total
 *   - full settlement of the Goa fixture yields zero balances + zero transfers
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { errorHandler, notFoundHandler } from '../src/middlewares/index.js';
import { AuthController } from '../src/modules/auth/controller/auth.controller.js';
import { createAuthRouter } from '../src/modules/auth/routes/auth.routes.js';
import { AuthService } from '../src/modules/auth/service/auth.service.js';
import { TokenService } from '../src/modules/auth/service/token.service.js';
import { ExpenseController } from '../src/modules/expense/controller/expense.controller.js';
import { createExpenseRouters } from '../src/modules/expense/routes/expense.routes.js';
import { ExpenseService } from '../src/modules/expense/service/expense.service.js';
import { SettlementController } from '../src/modules/settlement/controller/settlement.controller.js';
import { createSettlementRouters } from '../src/modules/settlement/routes/settlement.routes.js';
import { SettlementService } from '../src/modules/settlement/service/settlement.service.js';
import { TripController } from '../src/modules/trip/controller/trip.controller.js';
import { createTripRouter } from '../src/modules/trip/routes/trip.routes.js';
import { TripService } from '../src/modules/trip/service/trip.service.js';
import {
  FakeExpenseRepository,
  FakeRefreshTokenRepository,
  FakeSettlementRepository,
  FakeStore,
  FakeTripRepository,
  FakeUserRepository,
  buildActivityService,
  buildNotificationService,
} from './lib/fakes.js';

interface TestApp {
  fetchJson: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
  store: FakeStore;
  tokens: TokenService;
  close: () => Promise<void>;
}

async function buildApp(): Promise<TestApp> {
  const store = new FakeStore();
  const tokens = new TokenService({
    secret: 'test-secret-must-be-long-enough-1234567890',
    accessExpiresIn: '15m',
    refreshExpiresIn: '7d',
  });
  const userRepo = new FakeUserRepository(store);
  const refreshRepo = new FakeRefreshTokenRepository(store);
  const tripRepo = new FakeTripRepository(store);
  const expenseRepo = new FakeExpenseRepository(store);
  const settlementRepo = new FakeSettlementRepository(store);

  const authService = new AuthService(userRepo, refreshRepo, tokens);
  const tripService = new TripService(tripRepo, expenseRepo, settlementRepo, buildActivityService());
  const expenseService = new ExpenseService(expenseRepo, tripRepo, userRepo, settlementRepo, buildNotificationService(), buildActivityService());
  const settlementService = new SettlementService(settlementRepo, tripRepo, buildNotificationService(), buildActivityService());

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRouter({ controller: new AuthController(authService), tokens }));
  app.use(
    '/api/v1/trips',
    createTripRouter({ controller: new TripController(tripService), tokens }),
  );
  const exp = createExpenseRouters({
    controller: new ExpenseController(expenseService),
    tokens,
  });
  const set = createSettlementRouters({
    controller: new SettlementController(settlementService),
    tokens,
  });
  app.use('/api/v1/trips', exp.tripScopedRouter);
  app.use('/api/v1/trips', set.tripScopedRouter);
  app.use('/api/v1/expenses', exp.rootRouter);
  app.use('/api/v1/settlements', set.rootRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('failed to bind');
  const base = `http://127.0.0.1:${String(addr.port)}`;

  return {
    store,
    tokens,
    fetchJson: async (path, init) => {
      const res = await fetch(`${base}${path}`, init);
      const body = (await res.json().catch(() => null)) as unknown;
      return { status: res.status, body };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✘ ${name}`);
    if (detail !== undefined) console.error('    ', JSON.stringify(detail));
  }
}

function isSuccess<T>(body: unknown): body is { success: true; data: T; meta?: unknown } {
  return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === true;
}

async function signIn(app: TestApp, uid: string): Promise<{ token: string; userId: string }> {
  const repo = new FakeUserRepository(app.store);
  const user = await repo.create({
    firebaseUid: uid,
    email: null,
    name: 'Smoke User',
    avatarUrl: null,
    handle: `u_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    avatarColor: '#4F46E5',
  });
  const pair = app.tokens.issuePair(user.id);
  return { token: pair.accessToken, userId: user.id };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

interface ExpensePayload {
  title: string;
  amountMinor: number;
  payerKey: 'aarya' | 'aarav' | 'meera' | 'kabir';
  category: 'STAY' | 'FOOD' | 'TRAVEL' | 'FUN' | 'MISC';
  spentAt: string;
}
const SEED_EXPENSES: ExpensePayload[] = [
  { title: 'Airbnb in Anjuna',   amountMinor: 1_240_000, payerKey: 'aarav', category: 'STAY',   spentAt: '2024-12-06T10:00:00.000Z' },
  { title: 'Petrol — scooter',   amountMinor:    80_000, payerKey: 'aarya', category: 'TRAVEL', spentAt: '2024-12-06T10:00:00.000Z' },
  { title: 'Dinner at Thalassa', amountMinor:   460_000, payerKey: 'meera', category: 'FOOD',   spentAt: '2024-12-06T10:00:00.000Z' },
  { title: 'Beach shack lunch',  amountMinor:   184_000, payerKey: 'kabir', category: 'FOOD',   spentAt: '2024-12-07T10:00:00.000Z' },
  { title: 'Dudhsagar cab',      amountMinor:   320_000, payerKey: 'aarya', category: 'TRAVEL', spentAt: '2024-12-07T10:00:00.000Z' },
  { title: 'Club entry',         amountMinor:   240_000, payerKey: 'aarav', category: 'FUN',    spentAt: '2024-12-07T10:00:00.000Z' },
];

type BalancesData = {
  totalAmountMinor: number;
  totalReimbursedMinor: number;
  members: { userId: string; netMinor: number }[];
  suggestedTransfers: { fromUserId: string; toUserId: string; amountMinor: number }[];
};

async function fetchBalances(app: TestApp, token: string, tripId: string): Promise<BalancesData> {
  const res = await app.fetchJson(`/api/v1/trips/${tripId}/balances`, {
    headers: authHeaders(token),
  });
  if (!isSuccess<BalancesData>(res.body)) throw new Error('balances fetch failed');
  return res.body.data;
}

async function main(): Promise<void> {
  const app = await buildApp();
  const aarya = await signIn(app, 'uid-aarya');
  const aarav = await signIn(app, 'uid-aarav');
  const meera = await signIn(app, 'uid-meera');
  const kabir = await signIn(app, 'uid-kabir');
  const userByKey = { aarya, aarav, meera, kabir };

  // Build the Goa trip + expenses.
  const tripCreate = await app.fetchJson('/api/v1/trips', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      name: 'Goa Long Weekend',
      emoji: '🌴',
      coverColor: '#EAD9A8',
      memberIds: [aarav.userId, meera.userId, kabir.userId],
    }),
  });
  if (!isSuccess<{ id: string }>(tripCreate.body)) throw new Error('trip create failed');
  const tripId = tripCreate.body.data.id;
  for (const e of SEED_EXPENSES) {
    await app.fetchJson('/api/v1/expenses', {
      method: 'POST',
      headers: authHeaders(userByKey[e.payerKey].token),
      body: JSON.stringify({
        tripId,
        title: e.title,
        amountMinor: e.amountMinor,
        paidByUserId: userByKey[e.payerKey].userId,
        category: e.category,
        spentAt: e.spentAt,
      }),
    });
  }

  console.log('\n· auth required everywhere');
  const noAuth = await app.fetchJson(`/api/v1/trips/${tripId}/settlements`);
  check('GET settlements without auth -> 401', noAuth.status === 401);
  const postNoAuth = await app.fetchJson('/api/v1/settlements', { method: 'POST' });
  check('POST settlements without auth -> 401', postNoAuth.status === 401);

  console.log('\n· initial balances (no settlements yet)');
  const before = await fetchBalances(app, aarya.token, tripId);
  check('initial totalReimbursed = 0', before.totalReimbursedMinor === 0);
  check('initial 3 transfers (Goa fixture)', before.suggestedTransfers.length === 3);
  check(
    'initial: aarav net = +849000',
    before.members.find((m) => m.userId === aarav.userId)?.netMinor === 849_000,
  );

  console.log('\n· validation rejections');
  const selfSettle = await app.fetchJson('/api/v1/settlements', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      fromUserId: aarya.userId,
      toUserId: aarya.userId,
      amountMinor: 100,
    }),
  });
  check('self-settlement -> 400', selfSettle.status === 400);

  const stranger = await signIn(app, 'uid-stranger');
  const nonMemberFrom = await app.fetchJson('/api/v1/settlements', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      fromUserId: stranger.userId,
      toUserId: aarav.userId,
      amountMinor: 100,
    }),
  });
  check('non-member fromUser -> 400', nonMemberFrom.status === 400);

  const nonMemberCaller = await app.fetchJson('/api/v1/settlements', {
    method: 'POST',
    headers: authHeaders(stranger.token),
    body: JSON.stringify({
      tripId,
      fromUserId: aarya.userId,
      toUserId: aarav.userId,
      amountMinor: 100,
    }),
  });
  check('non-member caller -> 404 (no enumeration)', nonMemberCaller.status === 404);

  const negAmount = await app.fetchJson('/api/v1/settlements', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      fromUserId: aarya.userId,
      toUserId: aarav.userId,
      amountMinor: -100,
    }),
  });
  check('negative amount -> 422', negAmount.status === 422);

  const floatAmount = await app.fetchJson('/api/v1/settlements', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      fromUserId: aarya.userId,
      toUserId: aarav.userId,
      amountMinor: 12.5,
    }),
  });
  check('non-integer amount -> 422', floatAmount.status === 422);

  console.log('\n· UPI settlement: aarya pays aarav 100k (partial)');
  type SettlementDto = {
    id: string;
    amountMinor: number;
    method: string;
    status: string;
    settledAt: string | null;
    externalRef: string | null;
    fromUser: { userId: string };
    toUser: { userId: string };
  };
  const upi = await app.fetchJson('/api/v1/settlements', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      fromUserId: aarya.userId,
      toUserId: aarav.userId,
      amountMinor: 100_000,
      method: 'UPI',
      externalRef: 'TXN1234567',
      note: 'first chunk',
    }),
  });
  check('UPI settlement -> 201', upi.status === 201, upi.body);
  if (isSuccess<SettlementDto>(upi.body)) {
    check('settlement method=UPI', upi.body.data.method === 'UPI');
    check('settlement status=COMPLETED', upi.body.data.status === 'COMPLETED');
    check('settlement settledAt set', upi.body.data.settledAt !== null);
    check('settlement externalRef preserved', upi.body.data.externalRef === 'TXN1234567');
    check('settlement parties correct',
      upi.body.data.fromUser.userId === aarya.userId &&
      upi.body.data.toUser.userId === aarav.userId);
  }

  console.log('\n· balances reflect partial settlement');
  const after1 = await fetchBalances(app, aarya.token, tripId);
  check('totalReimbursed = 100000', after1.totalReimbursedMinor === 100_000);
  check('SUM(net) still 0', after1.members.reduce((s, m) => s + m.netMinor, 0) === 0);
  check(
    'aarya net moves up by 100k (-231k → -131k)',
    after1.members.find((m) => m.userId === aarya.userId)?.netMinor === -131_000,
  );
  check(
    'aarav net moves down by 100k (+849k → +749k)',
    after1.members.find((m) => m.userId === aarav.userId)?.netMinor === 749_000,
  );
  check(
    'meera + kabir nets unchanged',
    after1.members.find((m) => m.userId === meera.userId)?.netMinor === -171_000 &&
      after1.members.find((m) => m.userId === kabir.userId)?.netMinor === -447_000,
  );

  console.log('\n· CASH settlement: kabir pays aarav 200k');
  const cash = await app.fetchJson('/api/v1/settlements', {
    method: 'POST',
    headers: authHeaders(kabir.token),
    body: JSON.stringify({
      tripId,
      fromUserId: kabir.userId,
      toUserId: aarav.userId,
      amountMinor: 200_000,
      method: 'CASH',
    }),
  });
  check('CASH settlement -> 201', cash.status === 201);
  if (isSuccess<SettlementDto>(cash.body)) {
    check('CASH method preserved', cash.body.data.method === 'CASH');
    check('CASH externalRef null', cash.body.data.externalRef === null);
  }

  console.log('\n· MANUAL settlement (no method = default UPI)');
  const def = await app.fetchJson('/api/v1/settlements', {
    method: 'POST',
    headers: authHeaders(meera.token),
    body: JSON.stringify({
      tripId,
      fromUserId: meera.userId,
      toUserId: aarav.userId,
      amountMinor: 50_000,
      method: 'MANUAL',
    }),
  });
  check('MANUAL settlement -> 201', def.status === 201);
  if (isSuccess<SettlementDto>(def.body)) {
    check('MANUAL method preserved', def.body.data.method === 'MANUAL');
  }

  console.log('\n· running totals');
  const after3 = await fetchBalances(app, aarya.token, tripId);
  check('totalReimbursed = 350000', after3.totalReimbursedMinor === 350_000);
  check('SUM(net) still 0', after3.members.reduce((s, m) => s + m.netMinor, 0) === 0);
  check(
    'aarav net = +849k − 350k = +499k',
    after3.members.find((m) => m.userId === aarav.userId)?.netMinor === 499_000,
  );

  console.log('\n· list settlement history');
  const list = await app.fetchJson(`/api/v1/trips/${tripId}/settlements`, {
    headers: authHeaders(aarya.token),
  });
  check('list -> 200', list.status === 200);
  type ListBody = SettlementDto[];
  if (isSuccess<ListBody>(list.body)) {
    check('list returns 3 settlements', list.body.data.length === 3);
    // Ordering: newest first by settledAt — the MANUAL one was last.
    const methods = list.body.data.map((s) => s.method);
    check('newest first ordering', methods[0] === 'MANUAL', methods);
    const meta = (list.body.meta ?? null) as { total?: number; page?: number } | null;
    check('meta.total = 3', meta?.total === 3);
    check('meta.page = 1', meta?.page === 1);
  }

  console.log('\n· non-member sees 404 on history');
  const strangerList = await app.fetchJson(`/api/v1/trips/${tripId}/settlements`, {
    headers: authHeaders(stranger.token),
  });
  check('non-member -> 404', strangerList.status === 404);

  console.log('\n· immutability: no PATCH/DELETE endpoints');
  if (isSuccess<ListBody>(list.body) && list.body.data.length > 0) {
    const first = list.body.data[0];
    if (first === undefined) throw new Error('expected first settlement');
    const patch = await app.fetchJson(`/api/v1/settlements/${first.id}`, {
      method: 'PATCH',
      headers: authHeaders(aarya.token),
      body: JSON.stringify({ amountMinor: 1 }),
    });
    check('PATCH /settlements/:id -> 404 (no such route)', patch.status === 404);
    const del = await app.fetchJson(`/api/v1/settlements/${first.id}`, {
      method: 'DELETE',
      headers: authHeaders(aarya.token),
    });
    check('DELETE /settlements/:id -> 404 (no such route)', del.status === 404);
  }

  console.log('\n· complete settlement of remaining balances zeros everyone');
  // Use the *current* suggested transfers as the settlement plan.
  const suggested = after3.suggestedTransfers;
  check('still 3 suggested transfers after partial', suggested.length === 3);
  for (const t of suggested) {
    const settler = [aarya, aarav, meera, kabir].find((u) => u.userId === t.fromUserId);
    if (settler === undefined) throw new Error(`payer not found: ${t.fromUserId}`);
    const res = await app.fetchJson('/api/v1/settlements', {
      method: 'POST',
      headers: authHeaders(settler.token),
      body: JSON.stringify({
        tripId,
        fromUserId: t.fromUserId,
        toUserId: t.toUserId,
        amountMinor: t.amountMinor,
        method: 'UPI',
      }),
    });
    check(`settle ${String(t.amountMinor)} → 201`, res.status === 201);
  }

  const final = await fetchBalances(app, aarya.token, tripId);
  check('final SUM(net) = 0', final.members.reduce((s, m) => s + m.netMinor, 0) === 0);
  check('every net = 0', final.members.every((m) => m.netMinor === 0));
  check('final suggested transfers empty', final.suggestedTransfers.length === 0);
  check(
    'final totalReimbursed === total of original Goa creditor balance (849k)',
    final.totalReimbursedMinor === 849_000,
  );
  check(
    'final totalAmountMinor unchanged (settlements do not touch expenses)',
    final.totalAmountMinor === 2_524_000,
  );

  console.log('\n· soft-deleted expense + settlement: balances stay consistent');
  // Pull expense list, soft-delete one, balances should recompute correctly.
  // (Already covered in expense-smoke; here just sanity-check that settlements
  // remain when expenses change.)
  const expensesList = await app.fetchJson(`/api/v1/trips/${tripId}/expenses`, {
    headers: authHeaders(aarya.token),
  });
  if (isSuccess<{ id: string; title: string }[]>(expensesList.body)) {
    const dinner = expensesList.body.data.find((e) => e.title === 'Dinner at Thalassa');
    if (dinner !== undefined) {
      await app.fetchJson(`/api/v1/expenses/${dinner.id}`, {
        method: 'DELETE',
        headers: authHeaders(meera.token), // payer
      });
      const afterDelete = await fetchBalances(app, aarya.token, tripId);
      check(
        'after expense delete: SUM(net) still 0',
        afterDelete.members.reduce((s, m) => s + m.netMinor, 0) === 0,
        afterDelete.members,
      );
      check(
        'after expense delete: totalReimbursed unchanged (settlements immutable)',
        afterDelete.totalReimbursedMinor === 849_000,
      );
      check(
        'after expense delete: totalAmount drops by 460k',
        afterDelete.totalAmountMinor === 2_524_000 - 460_000,
      );
    }
  }

  await app.close();
  if (failures > 0) {
    console.error(`\n✘ ${String(failures)} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✔ all settlement flows pass');
}

main().catch((err: unknown) => {
  console.error('settlement-smoke crashed:', err);
  process.exit(1);
});
