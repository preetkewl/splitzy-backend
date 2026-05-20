/**
 * End-to-end Trip module smoke test.
 *
 * Boots the auth + trip routers wired against in-memory fake repos and
 * exercises:
 *   - create trip
 *   - list trips (mine vs theirs)
 *   - detail (member access vs non-member)
 *   - update (owner only)
 *   - add / remove members (owner only, can't remove owner)
 *   - soft delete (owner only)
 *   - validation errors (UUID / bounds)
 *   - auth required everywhere
 */
import express from 'express';
import {
  errorHandler,
  notFoundHandler,
} from '../src/middlewares/index.js';
import { randomUUID } from 'node:crypto';
import { AuthController } from '../src/modules/auth/controller/auth.controller.js';
import { createAuthRouter } from '../src/modules/auth/routes/auth.routes.js';
import { AuthService } from '../src/modules/auth/service/auth.service.js';
import { TokenService } from '../src/modules/auth/service/token.service.js';
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

interface JsonResult {
  status: number;
  body: unknown;
}
interface TestApp {
  fetchJson: (path: string, init?: RequestInit) => Promise<JsonResult>;
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
  const authController = new AuthController(authService);
  const tripService = new TripService(tripRepo, expenseRepo, settlementRepo);
  const tripController = new TripController(tripService);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRouter({ controller: authController, tokens }));
  app.use('/api/v1/trips', createTripRouter({ controller: tripController, tokens }));
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

// ──────────────────────────────────────────────────────────────────────────────

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✘ ${name}`);
    if (detail !== undefined) console.error('    ', JSON.stringify(detail));
  }
}

function isSuccess<T>(body: unknown): body is { success: true; data: T; meta?: unknown } {
  return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === true;
}
function isError(body: unknown): body is { success: false; error: { code: string; message: string } } {
  return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === false;
}

/** Create a user in the fake store and return a valid access token. */
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

// ──────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const app = await buildApp();

  // Seed four users directly (no Firebase needed).
  const aarya = await signIn(app, 'uid-aarya');
  const aarav = await signIn(app, 'uid-aarav');
  const meera = await signIn(app, 'uid-meera');
  const kabir = await signIn(app, 'uid-kabir');

  console.log('\n· auth required everywhere');
  const noAuth = await app.fetchJson('/api/v1/trips');
  check('GET /trips without auth -> 401', noAuth.status === 401);

  console.log('\n· create trip (Aarya owns)');
  const create = await app.fetchJson('/api/v1/trips', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      name: 'Goa Long Weekend',
      emoji: '🌴',
      coverColor: '#EAD9A8',
      description: 'Anjuna + Dudhsagar',
      memberIds: [aarav.userId, meera.userId, kabir.userId],
    }),
  });
  check('create -> 201', create.status === 201, create.body);
  const trip = isSuccess<{
    id: string;
    name: string;
    isOwner: boolean;
    memberCount: number;
    members: { userId: string; role: string }[];
    description: string | null;
    balanceSummary: { totalAmountPaise: number };
  }>(create.body)
    ? create.body.data
    : null;
  if (trip === null) throw new Error('create failed; aborting');
  check('isOwner true for creator', trip.isOwner === true);
  check('memberCount = 4', trip.memberCount === 4);
  check('members include all four', trip.members.length === 4);
  check(
    'creator is OWNER, others MEMBER',
    trip.members.find((m) => m.userId === aarya.userId)?.role === 'OWNER' &&
      trip.members.filter((m) => m.role === 'MEMBER').length === 3,
  );
  check('description echoed back', trip.description === 'Anjuna + Dudhsagar');
  check('balanceSummary present (placeholder)', trip.balanceSummary.totalAmountPaise === 0);

  console.log('\n· create with non-existent member -> 400');
  const badMember = await app.fetchJson('/api/v1/trips', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({
      name: 'Ghost Trip',
      emoji: '👻',
      memberIds: ['00000000-0000-0000-0000-000000000000'],
    }),
  });
  check('non-existent member -> 400', badMember.status === 400, badMember.body);

  console.log('\n· create with bad UUID -> 422');
  const badUuid = await app.fetchJson('/api/v1/trips', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({ name: 'X', emoji: '🌴', memberIds: ['not-a-uuid'] }),
  });
  check('bad uuid -> 422', badUuid.status === 422);

  console.log('\n· list trips for member');
  const listMine = await app.fetchJson('/api/v1/trips', {
    headers: authHeaders(aarya.token),
  });
  check('list -> 200', listMine.status === 200);
  type ListBody = { id: string; isOwner: boolean }[];
  if (isSuccess<ListBody>(listMine.body)) {
    check('list returns 1 trip for Aarya', listMine.body.data.length === 1);
    check('list isOwner correct for owner', listMine.body.data[0]?.isOwner === true);
  } else {
    check('list returns success envelope', false, listMine.body);
  }

  console.log('\n· list for member (non-owner sees same trip with isOwner=false)');
  const listMeera = await app.fetchJson('/api/v1/trips', {
    headers: authHeaders(meera.token),
  });
  if (isSuccess<ListBody>(listMeera.body)) {
    check('Meera sees the trip', listMeera.body.data.length === 1);
    check('isOwner false for Meera', listMeera.body.data[0]?.isOwner === false);
  }

  console.log('\n· detail (member can read)');
  const detailMember = await app.fetchJson(`/api/v1/trips/${trip.id}`, {
    headers: authHeaders(meera.token),
  });
  check('member detail -> 200', detailMember.status === 200);

  console.log('\n· detail (non-member -> 404, not 403)');
  const stranger = await signIn(app, 'uid-stranger');
  const detailStranger = await app.fetchJson(`/api/v1/trips/${trip.id}`, {
    headers: authHeaders(stranger.token),
  });
  check('non-member -> 404 (no enumeration)', detailStranger.status === 404);

  console.log('\n· detail with bad UUID -> 422');
  const detailBad = await app.fetchJson(`/api/v1/trips/not-a-uuid`, {
    headers: authHeaders(aarya.token),
  });
  check('bad UUID param -> 422', detailBad.status === 422);

  console.log('\n· update (owner only)');
  const updateAsMember = await app.fetchJson(`/api/v1/trips/${trip.id}`, {
    method: 'PATCH',
    headers: authHeaders(meera.token),
    body: JSON.stringify({ name: 'Hijack' }),
  });
  check('member update -> 403', updateAsMember.status === 403);

  const updateAsOwner = await app.fetchJson(`/api/v1/trips/${trip.id}`, {
    method: 'PATCH',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({ name: 'Goa Trip 2.0', description: null }),
  });
  check('owner update -> 200', updateAsOwner.status === 200);
  if (isSuccess<{ name: string; description: string | null }>(updateAsOwner.body)) {
    check('name updated', updateAsOwner.body.data.name === 'Goa Trip 2.0');
    check('description set to null', updateAsOwner.body.data.description === null);
  }

  console.log('\n· empty update body -> 422');
  const emptyUpdate = await app.fetchJson(`/api/v1/trips/${trip.id}`, {
    method: 'PATCH',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({}),
  });
  check('empty patch -> 422', emptyUpdate.status === 422);

  console.log('\n· add member (owner only)');
  const addAsMember = await app.fetchJson(`/api/v1/trips/${trip.id}/members`, {
    method: 'POST',
    headers: authHeaders(meera.token),
    body: JSON.stringify({ userIds: [stranger.userId] }),
  });
  check('member add -> 403', addAsMember.status === 403);

  const addAsOwner = await app.fetchJson(`/api/v1/trips/${trip.id}/members`, {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({ userIds: [stranger.userId] }),
  });
  check('owner add -> 200', addAsOwner.status === 200, addAsOwner.body);
  if (isSuccess<{ userId: string }[]>(addAsOwner.body)) {
    check('returned member set includes new user', addAsOwner.body.data.some((m) => m.userId === stranger.userId));
  }

  console.log('\n· add member idempotently (already in trip)');
  const addAgain = await app.fetchJson(`/api/v1/trips/${trip.id}/members`, {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({ userIds: [aarav.userId] }), // already a member
  });
  check('idempotent add -> 200', addAgain.status === 200);

  console.log('\n· remove member (owner only)');
  const removeAsMember = await app.fetchJson(
    `/api/v1/trips/${trip.id}/members/${stranger.userId}`,
    { method: 'DELETE', headers: authHeaders(kabir.token) },
  );
  check('member remove -> 403', removeAsMember.status === 403);

  const removeAsOwner = await app.fetchJson(
    `/api/v1/trips/${trip.id}/members/${stranger.userId}`,
    { method: 'DELETE', headers: authHeaders(aarya.token) },
  );
  check('owner remove -> 204', removeAsOwner.status === 204);

  console.log('\n· remove owner (forbidden)');
  const removeOwner = await app.fetchJson(
    `/api/v1/trips/${trip.id}/members/${aarya.userId}`,
    { method: 'DELETE', headers: authHeaders(aarya.token) },
  );
  check('owner-self remove -> 403', removeOwner.status === 403);

  console.log('\n· remove unknown member -> 404');
  const removeUnknown = await app.fetchJson(
    `/api/v1/trips/${trip.id}/members/00000000-0000-0000-0000-000000000000`,
    { method: 'DELETE', headers: authHeaders(aarya.token) },
  );
  check('unknown member -> 404', removeUnknown.status === 404);

  console.log('\n· soft delete (owner only)');
  const deleteAsMember = await app.fetchJson(`/api/v1/trips/${trip.id}`, {
    method: 'DELETE',
    headers: authHeaders(meera.token),
  });
  check('member delete -> 403', deleteAsMember.status === 403);

  const deleteAsOwner = await app.fetchJson(`/api/v1/trips/${trip.id}`, {
    method: 'DELETE',
    headers: authHeaders(aarya.token),
  });
  check('owner delete -> 204', deleteAsOwner.status === 204);

  console.log('\n· deleted trip is hidden from list + detail');
  const listAfterDelete = await app.fetchJson('/api/v1/trips', {
    headers: authHeaders(aarya.token),
  });
  if (isSuccess<unknown[]>(listAfterDelete.body)) {
    check('list excludes soft-deleted trip', listAfterDelete.body.data.length === 0);
  }
  const detailAfterDelete = await app.fetchJson(`/api/v1/trips/${trip.id}`, {
    headers: authHeaders(aarya.token),
  });
  check('detail of deleted trip -> 404', detailAfterDelete.status === 404);

  console.log('\n· pagination meta');
  for (let i = 0; i < 3; i += 1) {
    await app.fetchJson('/api/v1/trips', {
      method: 'POST',
      headers: authHeaders(aarya.token),
      body: JSON.stringify({
        name: `Trip ${String(i + 1)}`,
        emoji: '🛺',
        memberIds: [],
      }),
    });
  }
  const paged = await app.fetchJson('/api/v1/trips?page=1&pageSize=2', {
    headers: authHeaders(aarya.token),
  });
  if (isSuccess<unknown[]>(paged.body)) {
    check('pageSize=2 returns 2', paged.body.data.length === 2);
    const meta = (paged.body.meta ?? null) as { total?: number; page?: number; pageSize?: number } | null;
    check('meta.total = 3', meta?.total === 3);
    check('meta.pageSize = 2', meta?.pageSize === 2);
    check('meta.page = 1', meta?.page === 1);
  } else {
    check('paged response shape', false, paged.body);
  }

  // Validation: phone validation errors are caught by ZodError handler too.
  console.log('\n· error envelope shape');
  const v = await app.fetchJson('/api/v1/trips', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({ name: '', emoji: '🌴' }),
  });
  check('blank name -> 422', v.status === 422);
  check('error envelope shape', isError(v.body));

  await app.close();

  if (failures > 0) {
    console.error(`\n✘ ${String(failures)} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✔ all trip flows pass');
}

main().catch((err: unknown) => {
  console.error('trip-smoke crashed:', err);
  process.exit(1);
});
