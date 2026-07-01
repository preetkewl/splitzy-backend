/**
 * HTTP regression test for POST /subscriptions/verify — DB-free, network-free.
 *
 * Guards the exact bug that shipped once: the controller read `req.userId`
 * (nothing ever sets it) instead of `req.user.id`, so every authenticated verify
 * threw → 500. No purchase was bound to a user and premium could never be
 * granted. The service-level `smoke:verification` never caught it because it
 * calls VerificationService directly, skipping the auth → controller seam.
 *
 * This boots a real Express app with the REAL auth middleware + subscription
 * router, wired to a FAKE SubscriptionService that records what it receives, and
 * drives it over HTTP. No database, no Google.
 *
 * Asserts:
 *   1. Authenticated verify → 200 AND the service receives the TOKEN's userId
 *      and the request's purchaseToken.
 *   2. Missing Authorization → 401, and the service is NEVER reached.
 *   3. Malformed token → 401.
 *
 * Run: npm run smoke:verify-http
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { errorHandler } from '../src/middlewares/error-handler.js';
import type { VerificationResult } from '../src/modules/entitlement/service/verification.service.js';
import { TokenService } from '../src/modules/auth/service/token.service.js';
import { SubscriptionController } from '../src/modules/subscription/controller/subscription.controller.js';
import { createSubscriptionRouter } from '../src/modules/subscription/routes/subscription.routes.js';
import type { RtdnController } from '../src/modules/subscription/rtdn/rtdn.controller.js';
import type { SubscriptionService } from '../src/modules/subscription/service/subscription.service.js';

interface Captured {
  userId: string;
  purchaseToken: string;
}

async function main(): Promise<void> {
  const captured: Captured[] = [];

  // Fake service: records the (userId, purchaseToken) the controller passes it.
  const fakeService = {
    verify(userId: string, purchaseToken: string): Promise<VerificationResult> {
      captured.push({ userId, purchaseToken });
      return Promise.resolve({ isPremium: true, productId: 'settlio_premium_monthly', expiresAt: null });
    },
  } as unknown as SubscriptionService;

  // Only its `handle` property is referenced when the router is built; never called here.
  const fakeRtdn = { handle: (_req: unknown, _res: unknown): void => undefined } as unknown as RtdnController;

  // Self-contained TokenService: the SAME instance mints the token and verifies
  // it in requireAuth, so the test is independent of env.JWT_SECRET.
  const tokens = new TokenService({
    secret: 'regression-http-smoke-secret-0123456789',
    accessExpiresIn: '15m',
    refreshExpiresIn: '30d',
  });

  const app = express();
  app.use(express.json());
  const controller = new SubscriptionController(fakeService);
  const router = createSubscriptionRouter({ controller, rtdnController: fakeRtdn, tokens });
  app.use('/api/v1/subscriptions', router);
  app.use(errorHandler);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind port');
  const url = `http://127.0.0.1:${address.port}/api/v1/subscriptions/verify`;

  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  try {
    const userId = randomUUID();
    const { token } = tokens.signAccessToken(userId);

    // 1. Authenticated verify reaches the service with the TOKEN's userId.
    const ok = await post({ purchaseToken: 'tok_regression' }, { Authorization: `Bearer ${token}` });
    console.log(`POST /subscriptions/verify (authed)   -> ${ok.status}`);
    assert.equal(ok.status, 200, 'authenticated verify should be 200 (was 500 with the req.userId bug)');
    assert.equal(captured.length, 1, 'service should be called exactly once');
    assert.equal(captured[0]?.userId, userId, 'service must receive the TOKEN userId (regression: req.user.id)');
    assert.equal(captured[0]?.purchaseToken, 'tok_regression', 'service must receive the purchaseToken');

    // 2. Missing Authorization → 401, service untouched.
    const noAuth = await post({ purchaseToken: 'tok_x' });
    console.log(`POST /subscriptions/verify (no auth)   -> ${noAuth.status}`);
    assert.equal(noAuth.status, 401, 'missing auth should be 401');
    assert.equal(captured.length, 1, 'unauthenticated request must NOT reach the service');

    // 3. Malformed token → 401.
    const badToken = await post({ purchaseToken: 'tok_x' }, { Authorization: 'Bearer not-a-jwt' });
    console.log(`POST /subscriptions/verify (bad token) -> ${badToken.status}`);
    assert.equal(badToken.status, 401, 'malformed token should be 401');
    assert.equal(captured.length, 1, 'malformed-token request must NOT reach the service');

    console.log('\n✅ subscription verify HTTP smoke passed');
  } finally {
    server.close();
  }
}

main().catch((err: unknown) => {
  console.error('\n❌ subscription verify HTTP smoke FAILED');
  console.error(err);
  process.exit(1);
});
