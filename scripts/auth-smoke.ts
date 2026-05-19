/**
 * End-to-end auth smoke test using the shared in-memory fakes
 * (`scripts/lib/fakes.ts`).
 *
 * Exercises the full state machine without needing Postgres or Firebase:
 *   direct-token-seed → me → updateProfile → refresh → logout → refresh-after-logout
 *
 * The /auth/google endpoint requires a live Firebase ID token so it is
 * covered only at the validation layer (missing idToken → 422).
 * All downstream session mechanics (protect, me, refresh, logout) are
 * exercised by seeding users + tokens directly in the fake store.
 *
 * Asserts each step, prints a summary, exits 1 on any failure.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { errorHandler, notFoundHandler, validateRequest } from '../src/middlewares/index.js';
import { requireAuth } from '../src/middlewares/require-auth.js';
import { AuthController } from '../src/modules/auth/controller/auth.controller.js';
import { createAuthRouter } from '../src/modules/auth/routes/auth.routes.js';
import { AuthService } from '../src/modules/auth/service/auth.service.js';
import { TokenService } from '../src/modules/auth/service/token.service.js';
import { FakeRefreshTokenRepository, FakeStore, FakeUserRepository } from './lib/fakes.js';

interface TestApp {
  fetchJson: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
  store: FakeStore;
  tokens: TokenService;
  close: () => Promise<void>;
}

async function buildTestApp(): Promise<TestApp> {
  const store = new FakeStore();
  const tokens = new TokenService({
    secret: 'test-secret-must-be-long-enough-1234567890',
    accessExpiresIn: '15m',
    refreshExpiresIn: '7d',
  });
  const service = new AuthService(
    new FakeUserRepository(store),
    new FakeRefreshTokenRepository(store),
    tokens,
  );
  const controller = new AuthController(service);
  const router = createAuthRouter({ controller, tokens });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', router);
  app.get(
    '/api/v1/protected',
    requireAuth(tokens),
    validateRequest({}),
    (req, res) => {
      res.json({ success: true, data: { userId: req.user?.id } });
    },
  );
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

/** Seed a user directly into the store and issue a real token pair. */
async function seedUser(
  store: FakeStore,
  tokens: TokenService,
  uid: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const repo = new FakeUserRepository(store);
  const user = await repo.create({
    firebaseUid: uid,
    email: `${uid}@smoke.test`,
    name: '',
    avatarUrl: null,
    handle: `u_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    avatarColor: '#4F46E5',
  });
  const pair = tokens.issuePair(user.id);
  // Store the refresh token in the fake so refresh/logout work correctly.
  const refreshRepo = new FakeRefreshTokenRepository(store);
  await refreshRepo.create({
    userId: user.id,
    tokenHash: tokens.hashRefreshToken(pair.refreshToken),
    expiresAt: pair.refreshTokenExpiresAt,
    userAgent: null,
    ipAddress: null,
  });
  return { accessToken: pair.accessToken, refreshToken: pair.refreshToken, userId: user.id };
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✘ ${name}`);
    if (detail !== undefined) console.error('    ', detail);
  }
}

function isSuccess(body: unknown): body is { success: true; data: Record<string, unknown> } {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { success?: unknown }).success === true
  );
}

function isError(body: unknown): body is { success: false; error: { code: string; message: string } } {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { success?: unknown }).success === false
  );
}

async function main(): Promise<void> {
  const app = await buildTestApp();

  console.log('\n· /auth/google input validation');
  const noToken = await app.fetchJson('/api/v1/auth/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('missing idToken -> 422', noToken.status === 422, noToken);
  check('missing idToken -> error envelope', isError(noToken.body));

  const emptyToken = await app.fetchJson('/api/v1/auth/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: '' }),
  });
  check('empty idToken -> 422', emptyToken.status === 422, emptyToken);

  // Seed a user + tokens directly (skips Firebase — we cannot call verifyIdToken here).
  const { accessToken, refreshToken, userId } = await seedUser(app.store, app.tokens, 'firebase-uid-alice');

  console.log('\n· protected route without auth');
  const noAuth = await app.fetchJson('/api/v1/protected');
  check('no auth -> 401', noAuth.status === 401, noAuth);

  console.log('\n· protected route with access token');
  const ok = await app.fetchJson('/api/v1/protected', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  check('with access token -> 200', ok.status === 200, ok);
  check(
    'protected echoes user id',
    isSuccess(ok.body) && ok.body.data['userId'] === userId,
  );

  console.log('\n· me');
  const me = await app.fetchJson('/api/v1/auth/me', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  check('me -> 200', me.status === 200, me);
  check('me returns correct user id', isSuccess(me.body) && me.body.data['id'] === userId);
  const meUser = isSuccess(me.body)
    ? (me.body.data as { profileComplete: boolean; name: string })
    : null;
  check('profile starts incomplete', meUser !== null && meUser.profileComplete === false);

  console.log('\n· profile update');
  const profile = await app.fetchJson('/api/v1/auth/profile', {
    method: 'PUT',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Aarya Sharma', upiId: 'aarya@okhdfcbank' }),
  });
  check('profile update -> 200', profile.status === 200, profile);
  check(
    'profile now complete',
    isSuccess(profile.body) && profile.body.data['profileComplete'] === true,
  );

  console.log('\n· profile update validation');
  const badProfile = await app.fetchJson('/api/v1/auth/profile', {
    method: 'PUT',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('empty body -> 422', badProfile.status === 422, badProfile);

  console.log('\n· refresh');
  const refresh = await app.fetchJson('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  check('refresh -> 200', refresh.status === 200, refresh);
  const rotated = isSuccess(refresh.body) ? refresh.body.data : null;
  if (rotated === null) throw new Error('refresh failed; aborting');
  const newRefresh = rotated['refreshToken'] as string;
  check('new refresh token differs', newRefresh !== refreshToken);

  console.log('\n· refresh again with old token');
  const replay = await app.fetchJson('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  check('reused refresh -> 401', replay.status === 401, replay);
  check(
    'reused refresh -> INVALID_TOKEN',
    isError(replay.body) && replay.body.error.code === 'INVALID_TOKEN',
  );

  console.log('\n· logout with current refresh');
  const logout = await app.fetchJson('/api/v1/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: newRefresh }),
  });
  check('logout -> 204', logout.status === 204, logout);

  console.log('\n· refresh after logout');
  const afterLogout = await app.fetchJson('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: newRefresh }),
  });
  check('refresh post-logout -> 401', afterLogout.status === 401, afterLogout);

  // Seed a second user; confirm they get a different id.
  const second = await seedUser(app.store, app.tokens, 'firebase-uid-bob');
  check('second user gets distinct id', second.userId !== userId);

  await app.close();

  if (failures > 0) {
    console.error(`\n✘ ${String(failures)} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✔ all auth flows pass');
}

main().catch((err: unknown) => {
  console.error('auth-smoke crashed:', err);
  process.exit(1);
});
