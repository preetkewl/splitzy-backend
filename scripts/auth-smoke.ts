/**
 * End-to-end auth smoke test using the shared in-memory fakes
 * (`scripts/lib/fakes.ts`).
 *
 * Exercises the full state machine without needing Postgres:
 *   login → verify → me → updateProfile → refresh → logout → refresh-after-logout
 *
 * Asserts each step, prints a summary, exits 1 on any failure.
 */
import express from 'express';
import { errorHandler, notFoundHandler, validateRequest } from '../src/middlewares/index.js';
import { requireAuth } from '../src/middlewares/require-auth.js';
import { AuthController } from '../src/modules/auth/controller/auth.controller.js';
import { createAuthRouter } from '../src/modules/auth/routes/auth.routes.js';
import { AuthService } from '../src/modules/auth/service/auth.service.js';
import { MockOtpProvider } from '../src/modules/auth/service/otp/mock-otp.provider.js';
import { TokenService } from '../src/modules/auth/service/token.service.js';
import { FakeRefreshTokenRepository, FakeStore, FakeUserRepository } from './lib/fakes.js';

interface TestApp {
  fetchJson: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
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
    new MockOtpProvider(),
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
  const phone = '+919876512345';

  console.log('\n· login');
  const login = await app.fetchJson('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  check('login returns 200', login.status === 200, login);
  const challengeToken = isSuccess(login.body) ? (login.body.data.challengeToken as string) : '';
  const devOtp = isSuccess(login.body) ? (login.body.data.devOtp as string | undefined) : undefined;
  check('challengeToken present', typeof challengeToken === 'string' && challengeToken.length > 0);
  check('devOtp present in non-prod', devOtp === '123456', devOtp);

  console.log('\n· login validation rejects bad phone');
  const badLogin = await app.fetchJson('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: 'not-a-phone' }),
  });
  check('bad phone -> 422', badLogin.status === 422, badLogin);
  check('bad phone -> error envelope', isError(badLogin.body));

  console.log('\n· verify with wrong OTP');
  const wrongOtp = await app.fetchJson('/api/v1/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken, otp: '000000' }),
  });
  check('wrong otp -> 401', wrongOtp.status === 401, wrongOtp);
  check(
    'wrong otp -> INVALID_CREDENTIALS',
    isError(wrongOtp.body) && wrongOtp.body.error.code === 'INVALID_CREDENTIALS',
    wrongOtp,
  );

  console.log('\n· verify with correct OTP');
  const verify = await app.fetchJson('/api/v1/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken, otp: '123456' }),
  });
  check('verify -> 200', verify.status === 200, verify);
  const session = isSuccess(verify.body) ? verify.body.data : null;
  if (session === null) throw new Error('verify failed; aborting');

  const accessToken = session.accessToken as string;
  const refreshToken = session.refreshToken as string;
  const user = session.user as { id: string; phone: string; profileComplete: boolean; name: string };
  check('access token issued', typeof accessToken === 'string' && accessToken.split('.').length === 3);
  check('refresh token issued', typeof refreshToken === 'string' && refreshToken.split('.').length === 3);
  check('user has correct phone', user.phone === phone);
  check('profile starts incomplete', user.profileComplete === false && user.name === '');

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
    isSuccess(ok.body) && ok.body.data['userId'] === user.id,
  );

  console.log('\n· me');
  const me = await app.fetchJson('/api/v1/auth/me', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  check('me -> 200', me.status === 200, me);
  check('me returns same user id', isSuccess(me.body) && me.body.data['id'] === user.id);

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

  console.log('\n· refresh');
  const refresh = await app.fetchJson('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  check('refresh -> 200', refresh.status === 200, refresh);
  const rotated = isSuccess(refresh.body) ? refresh.body.data : null;
  if (rotated === null) throw new Error('refresh failed; aborting');
  const newRefresh = rotated.refreshToken as string;
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

  console.log('\n· login again with same phone');
  const login2 = await app.fetchJson('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  const challenge2 = isSuccess(login2.body) ? (login2.body.data.challengeToken as string) : '';
  const verify2 = await app.fetchJson('/api/v1/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken: challenge2, otp: '123456' }),
  });
  check('verify-2 -> 200', verify2.status === 200, verify2);
  const u2 = isSuccess(verify2.body)
    ? (verify2.body.data['user'] as { id: string; profileComplete: boolean })
    : null;
  check('returning user has same id', u2 !== null && u2.id === user.id);
  check('returning user profile still complete', u2 !== null && u2.profileComplete === true);

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
