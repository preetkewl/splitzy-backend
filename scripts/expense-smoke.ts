/**
 * End-to-end Expense + Balances smoke test.
 *
 * Wires the auth + trip + expense routers against in-memory fakes,
 * signs in 4 users, creates the Goa trip, posts the 6 fixture expenses,
 * and asserts:
 *   - expense create with default + explicit participants
 *   - expense create rejects malformed input (non-trip-payer, non-int
 *     amount, payer-not-in-participants)
 *   - list + canDelete flag for payer / owner / random member
 *   - balances endpoint matches the engine's computed numbers exactly,
 *     SUM(net) === 0
 *   - delete by payer + delete by owner + non-payer non-owner forbidden
 *   - deleted expense disappears from list and balances
 */
import express from 'express';
import { errorHandler, notFoundHandler } from '../src/middlewares/index.js';
import { AuthController } from '../src/modules/auth/controller/auth.controller.js';
import { createAuthRouter } from '../src/modules/auth/routes/auth.routes.js';
import { AuthService } from '../src/modules/auth/service/auth.service.js';
import { MockOtpProvider } from '../src/modules/auth/service/otp/mock-otp.provider.js';
import { TokenService } from '../src/modules/auth/service/token.service.js';
import { ExpenseController } from '../src/modules/expense/controller/expense.controller.js';
import { createExpenseRouters } from '../src/modules/expense/routes/expense.routes.js';
import { ExpenseService } from '../src/modules/expense/service/expense.service.js';
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
} from './lib/fakes.js';

interface TestApp {
  fetchJson: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
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
  // Step 6: settlement repo is a dependency of ExpenseService for balance
  // computation. The expense smoke test never creates settlements, so the
  // fake's empty-list return keeps totalReimbursedPaise at 0.
  const settlementRepo = new FakeSettlementRepository(store);

  const authService = new AuthService(userRepo, refreshRepo, new MockOtpProvider(), tokens);
  const tripService = new TripService(tripRepo);
  const expenseService = new ExpenseService(expenseRepo, tripRepo, userRepo, settlementRepo);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRouter({ controller: new AuthController(authService), tokens }));
  app.use('/api/v1/trips', createTripRouter({ controller: new TripController(tripService), tokens }));
  const exp = createExpenseRouters({ controller: new ExpenseController(expenseService), tokens });
  app.use('/api/v1/trips', exp.tripScopedRouter);
  app.use('/api/v1/expenses', exp.rootRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('failed to bind');
  const base = `http://127.0.0.1:${String(addr.port)}`;

  return {
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

async function signIn(app: TestApp, phone: string): Promise<{ token: string; userId: string }> {
  const login = await app.fetchJson('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  if (!isSuccess<{ challengeToken: string }>(login.body)) throw new Error('login failed');
  const verify = await app.fetchJson('/api/v1/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken: login.body.data.challengeToken, otp: '123456' }),
  });
  if (!isSuccess<{ accessToken: string; user: { id: string } }>(verify.body)) {
    throw new Error('verify failed');
  }
  return { token: verify.body.data.accessToken, userId: verify.body.data.user.id };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

interface ExpensePayload {
  title: string;
  amountPaise: number;
  payerKey: 'aarya' | 'aarav' | 'meera' | 'kabir';
  category: 'STAY' | 'FOOD' | 'TRAVEL' | 'FUN' | 'MISC';
  spentAt: string;
}

const SEED_EXPENSES: ExpensePayload[] = [
  { title: 'Airbnb in Anjuna',   amountPaise: 1_240_000, payerKey: 'aarav', category: 'STAY',   spentAt: '2024-12-06T10:00:00.000Z' },
  { title: 'Petrol — scooter',   amountPaise:    80_000, payerKey: 'aarya', category: 'TRAVEL', spentAt: '2024-12-06T10:00:00.000Z' },
  { title: 'Dinner at Thalassa', amountPaise:   460_000, payerKey: 'meera', category: 'FOOD',   spentAt: '2024-12-06T10:00:00.000Z' },
  { title: 'Beach shack lunch',  amountPaise:   184_000, payerKey: 'kabir', category: 'FOOD',   spentAt: '2024-12-07T10:00:00.000Z' },
  { title: 'Dudhsagar cab',      amountPaise:   320_000, payerKey: 'aarya', category: 'TRAVEL', spentAt: '2024-12-07T10:00:00.000Z' },
  { title: 'Club entry',         amountPaise:   240_000, payerKey: 'aarav', category: 'FUN',    spentAt: '2024-12-07T10:00:00.000Z' },
];

async function main(): Promise<void> {
  const app = await buildApp();

  const aarya = await signIn(app, '+919876512345');
  const aarav = await signIn(app, '+919876543210');
  const meera = await signIn(app, '+918765432109');
  const kabir = await signIn(app, '+917654321098');
  const userByKey = { aarya, aarav, meera, kabir };

  console.log('\n· bootstrap Goa trip (Aarya owns)');
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
  check('trip created', tripCreate.status === 201);

  console.log('\n· auth required everywhere');
  const noAuth = await app.fetchJson(`/api/v1/trips/${tripId}/expenses`);
  check('GET expenses without auth -> 401', noAuth.status === 401);

  console.log('\n· post 6 expenses (default participants = all members)');
  for (const e of SEED_EXPENSES) {
    const res = await app.fetchJson('/api/v1/expenses', {
      method: 'POST',
      headers: authHeaders(userByKey[e.payerKey].token),
      body: JSON.stringify({
        tripId,
        title: e.title,
        amountPaise: e.amountPaise,
        paidByUserId: userByKey[e.payerKey].userId,
        category: e.category,
        spentAt: e.spentAt,
      }),
    });
    check(`POST ${e.title} -> 201`, res.status === 201, res.body);
    if (isSuccess<{
      participants: { userId: string; sharePaise: number }[];
      paidBy: { userId: string };
      amountPaise: number;
    }>(res.body)) {
      const sum = res.body.data.participants.reduce((s, p) => s + p.sharePaise, 0);
      check(
        `${e.title}: SUM(shares) === amountPaise`,
        sum === e.amountPaise,
        { sum, amountPaise: e.amountPaise },
      );
    }
  }

  console.log('\n· list expenses for trip');
  const list = await app.fetchJson(`/api/v1/trips/${tripId}/expenses`, {
    headers: authHeaders(meera.token),
  });
  check('list -> 200', list.status === 200);
  if (
    isSuccess<
      {
        id: string;
        title: string;
        canDelete: boolean;
        paidBy: { userId: string };
      }[]
    >(list.body)
  ) {
    check('list returns 6 expenses', list.body.data.length === 6);
    // canDelete: meera is payer of "Dinner at Thalassa" only.
    const myDinner = list.body.data.find((x) => x.title === 'Dinner at Thalassa');
    const aarbnb = list.body.data.find((x) => x.title === 'Airbnb in Anjuna');
    check(
      'canDelete=true for own expense (Meera/Dinner)',
      myDinner !== undefined && myDinner.canDelete === true,
    );
    check(
      'canDelete=false for someone else\'s expense (Aarav/Airbnb)',
      aarbnb !== undefined && aarbnb.canDelete === false,
    );
  }

  console.log('\n· list with owner -> canDelete: true for everything');
  const ownerList = await app.fetchJson(`/api/v1/trips/${tripId}/expenses`, {
    headers: authHeaders(aarya.token),
  });
  if (isSuccess<{ canDelete: boolean }[]>(ownerList.body)) {
    check(
      'owner sees canDelete=true for all',
      ownerList.body.data.every((x) => x.canDelete === true),
    );
  }

  console.log('\n· balances');
  const balances = await app.fetchJson(`/api/v1/trips/${tripId}/balances`, {
    headers: authHeaders(meera.token),
  });
  check('balances -> 200', balances.status === 200);
  type BalancesData = {
    totalAmountPaise: number;
    totalReimbursedPaise: number;
    members: { userId: string; netPaise: number; totalPaidPaise: number; totalSharePaise: number }[];
    suggestedTransfers: { fromUserId: string; toUserId: string; amountPaise: number }[];
  };
  if (isSuccess<BalancesData>(balances.body)) {
    const b = balances.body.data;
    check('totalAmountPaise = 25,24,000', b.totalAmountPaise === 2_524_000);
    check('totalReimbursedPaise = 0 (no settlements yet)', b.totalReimbursedPaise === 0);
    check('4 member balances', b.members.length === 4);
    const sum = b.members.reduce((s, m) => s + m.netPaise, 0);
    check('SUM(net) === 0', sum === 0, b.members);
    const aarav_ = b.members.find((m) => m.userId === aarav.userId);
    const aarya_ = b.members.find((m) => m.userId === aarya.userId);
    const meera_ = b.members.find((m) => m.userId === meera.userId);
    const kabir_ = b.members.find((m) => m.userId === kabir.userId);
    check('aarav net = +849000', aarav_?.netPaise === 849_000, aarav_);
    check('aarya net = -231000', aarya_?.netPaise === -231_000, aarya_);
    check('meera net = -171000', meera_?.netPaise === -171_000, meera_);
    check('kabir net = -447000', kabir_?.netPaise === -447_000, kabir_);
    check('aarav totalPaid = 1480000', aarav_?.totalPaidPaise === 1_480_000);
    check('aarav totalShare = 631000', aarav_?.totalSharePaise === 631_000);
    check('every member is current', b.members.every((m) => 'isCurrentMember' in m));
    check('3 suggested transfers', b.suggestedTransfers.length === 3);
    check(
      'every transfer points at aarav',
      b.suggestedTransfers.every((t) => t.toUserId === aarav.userId),
    );
    check(
      'transfers SUM === aarav.netPaise',
      b.suggestedTransfers.reduce((s, t) => s + t.amountPaise, 0) === 849_000,
    );
  }

  console.log('\n· non-member sees 404 on balances/expenses');
  const stranger = await signIn(app, '+919999999999');
  const strangerBal = await app.fetchJson(`/api/v1/trips/${tripId}/balances`, {
    headers: authHeaders(stranger.token),
  });
  check('non-member balances -> 404', strangerBal.status === 404);
  const strangerList = await app.fetchJson(`/api/v1/trips/${tripId}/expenses`, {
    headers: authHeaders(stranger.token),
  });
  check('non-member expenses -> 404', strangerList.status === 404);

  console.log('\n· create rejects malformed input');
  const badPayer = await app.fetchJson('/api/v1/expenses', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      title: 'Mystery snack',
      amountPaise: 1000,
      paidByUserId: stranger.userId, // not a trip member
      spentAt: '2024-12-08T10:00:00.000Z',
    }),
  });
  check('non-member payer -> 400', badPayer.status === 400, badPayer.body);

  const nonIntAmount = await app.fetchJson('/api/v1/expenses', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      title: 'Bad amount',
      amountPaise: 12.5,
      paidByUserId: aarya.userId,
      spentAt: '2024-12-08T10:00:00.000Z',
    }),
  });
  check('non-integer amount -> 422', nonIntAmount.status === 422);

  const negAmount = await app.fetchJson('/api/v1/expenses', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      title: 'Negative',
      amountPaise: -10,
      paidByUserId: aarya.userId,
      spentAt: '2024-12-08T10:00:00.000Z',
    }),
  });
  check('negative amount -> 422', negAmount.status === 422);

  const payerNotInList = await app.fetchJson('/api/v1/expenses', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      title: 'Subset split',
      amountPaise: 1000,
      paidByUserId: aarya.userId,
      participantIds: [aarav.userId, meera.userId], // payer missing
      spentAt: '2024-12-08T10:00:00.000Z',
    }),
  });
  check('payer not in participants -> 400', payerNotInList.status === 400);

  console.log('\n· delete: payer can, others cannot');
  // Find the Dinner expense (Meera paid)
  const dinnerList = await app.fetchJson(`/api/v1/trips/${tripId}/expenses`, {
    headers: authHeaders(meera.token),
  });
  const dinnerId = isSuccess<{ id: string; title: string }[]>(dinnerList.body)
    ? dinnerList.body.data.find((x) => x.title === 'Dinner at Thalassa')?.id
    : undefined;
  if (dinnerId === undefined) throw new Error('dinner not found; aborting');

  const deleteByOther = await app.fetchJson(`/api/v1/expenses/${dinnerId}`, {
    method: 'DELETE',
    headers: authHeaders(kabir.token),
  });
  check('non-payer non-owner delete -> 403', deleteByOther.status === 403);

  const deleteByPayer = await app.fetchJson(`/api/v1/expenses/${dinnerId}`, {
    method: 'DELETE',
    headers: authHeaders(meera.token),
  });
  check('payer delete -> 204', deleteByPayer.status === 204);

  console.log('\n· deleted expense disappears from list and balances');
  const listAfter = await app.fetchJson(`/api/v1/trips/${tripId}/expenses`, {
    headers: authHeaders(aarya.token),
  });
  if (isSuccess<{ id: string }[]>(listAfter.body)) {
    check('5 expenses after delete', listAfter.body.data.length === 5);
    check(
      'deleted expense not in list',
      !listAfter.body.data.some((x) => x.id === dinnerId),
    );
  }
  const balancesAfter = await app.fetchJson(`/api/v1/trips/${tripId}/balances`, {
    headers: authHeaders(aarya.token),
  });
  if (isSuccess<{ totalAmountPaise: number; members: { netPaise: number }[] }>(balancesAfter.body)) {
    check(
      'totalAmountPaise drops by 460000',
      balancesAfter.body.data.totalAmountPaise === 2_524_000 - 460_000,
    );
    const sum = balancesAfter.body.data.members.reduce((s, m) => s + m.netPaise, 0);
    check('SUM(net) === 0 still', sum === 0);
  }

  console.log('\n· delete by trip owner (different expense)');
  const airbnbList = await app.fetchJson(`/api/v1/trips/${tripId}/expenses`, {
    headers: authHeaders(aarya.token),
  });
  const airbnbId = isSuccess<{ id: string; title: string }[]>(airbnbList.body)
    ? airbnbList.body.data.find((x) => x.title === 'Airbnb in Anjuna')?.id
    : undefined;
  if (airbnbId === undefined) throw new Error('airbnb missing');
  const ownerDelete = await app.fetchJson(`/api/v1/expenses/${airbnbId}`, {
    method: 'DELETE',
    headers: authHeaders(aarya.token), // aarya is owner; aarav is payer
  });
  check('owner delete (not payer) -> 204', ownerDelete.status === 204);

  console.log('\n· delete on unknown id -> 404');
  const ghostId = '00000000-0000-0000-0000-000000000000';
  const ghost = await app.fetchJson(`/api/v1/expenses/${ghostId}`, {
    method: 'DELETE',
    headers: authHeaders(aarya.token),
  });
  check('unknown expense -> 404', ghost.status === 404);

  console.log('\n· non-clean split: payer absorbs remainder');
  const odd = await app.fetchJson('/api/v1/expenses', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      title: 'Awkward chai bill',
      amountPaise: 100, // 100/4 = 25 clean — try 101 instead
      paidByUserId: aarya.userId,
      spentAt: '2024-12-08T10:00:00.000Z',
    }),
  });
  check('clean 100/4 ok', odd.status === 201);
  const remainderRes = await app.fetchJson('/api/v1/expenses', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      tripId,
      title: 'Remainder test',
      amountPaise: 101, // 101/4 = 25 floor + 1 remainder
      paidByUserId: aarya.userId,
      spentAt: '2024-12-08T10:00:00.000Z',
    }),
  });
  if (
    isSuccess<{ participants: { userId: string; sharePaise: number }[]; paidBy: { userId: string } }>(
      remainderRes.body,
    )
  ) {
    const data = remainderRes.body.data;
    const sum = data.participants.reduce((s, p) => s + p.sharePaise, 0);
    check('remainder: SUM(shares) === 101', sum === 101);
    const payerShare = data.participants.find((p) => p.userId === aarya.userId)?.sharePaise;
    const otherShare = data.participants.find((p) => p.userId !== aarya.userId)?.sharePaise;
    check('remainder: payer share = 26 (25 + 1)', payerShare === 26);
    check('remainder: non-payer share = 25', otherShare === 25);
  }

  await app.close();

  if (failures > 0) {
    console.error(`\n✘ ${String(failures)} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✔ all expense flows pass');
}

main().catch((err: unknown) => {
  console.error('expense-smoke crashed:', err);
  process.exit(1);
});
