/**
 * End-to-end Friends + Requests smoke test.
 *
 * Wires the auth + friend routers against in-memory fakes, signs in
 * 4 users, exercises:
 *   - GET /friends/search by name / handle / phone, with self-exclusion
 *   - relationship state in search results (none → outgoing → friend)
 *   - POST /friends/request: self-rejection, duplicates (idempotent),
 *     reverse-direction conflict, reopen of declined requests
 *   - accept / reject ownership rules + state transitions
 *   - GET /friends list returns the friend (the OTHER user, not self)
 *   - canonical Friendship pair preserved regardless of who sent first
 *   - search now reflects the friendship
 */
import express from 'express';
import { errorHandler, notFoundHandler } from '../src/middlewares/index.js';
import { AuthController } from '../src/modules/auth/controller/auth.controller.js';
import { createAuthRouter } from '../src/modules/auth/routes/auth.routes.js';
import { AuthService } from '../src/modules/auth/service/auth.service.js';
import { MockOtpProvider } from '../src/modules/auth/service/otp/mock-otp.provider.js';
import { TokenService } from '../src/modules/auth/service/token.service.js';
import { FriendController } from '../src/modules/friend/controller/friend.controller.js';
import { createFriendRouter } from '../src/modules/friend/routes/friend.routes.js';
import { FriendService } from '../src/modules/friend/service/friend.service.js';
import {
  FakeFriendRepository,
  FakeRefreshTokenRepository,
  FakeStore,
  FakeUserRepository,
} from './lib/fakes.js';

interface TestApp {
  fetchJson: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
  store: FakeStore;
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
  const friendRepo = new FakeFriendRepository(store);

  const authService = new AuthService(userRepo, refreshRepo, new MockOtpProvider(), tokens);
  const friendService = new FriendService(friendRepo, userRepo);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRouter({ controller: new AuthController(authService), tokens }));
  app.use(
    '/api/v1/friends',
    createFriendRouter({ controller: new FriendController(friendService), tokens }),
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
function isError(body: unknown): body is { success: false; error: { code: string; message: string } } {
  return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === false;
}

async function signIn(
  app: TestApp,
  phone: string,
  profile: { name: string; handle?: string },
): Promise<{ token: string; userId: string }> {
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
  const token = verify.body.data.accessToken;
  const userId = verify.body.data.user.id;
  // Set name + handle so /search has predictable data.
  await app.fetchJson('/api/v1/auth/profile', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: profile.name, handle: profile.handle ?? profile.name.toLowerCase() }),
  });
  return { token, userId };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function main(): Promise<void> {
  const app = await buildApp();

  const aarya = await signIn(app, '+919876512345', { name: 'Aarya Sharma', handle: 'aarya' });
  const aarav = await signIn(app, '+919876543210', { name: 'Aarav', handle: 'aarav' });
  const meera = await signIn(app, '+918765432109', { name: 'Meera', handle: 'meera' });
  const kabir = await signIn(app, '+917654321098', { name: 'Kabir', handle: 'kabir' });

  console.log('\n· auth required everywhere');
  const noAuth = await app.fetchJson('/api/v1/friends');
  check('GET /friends without auth -> 401', noAuth.status === 401);
  const searchNoAuth = await app.fetchJson('/api/v1/friends/search?q=aar');
  check('GET /friends/search without auth -> 401', searchNoAuth.status === 401);

  console.log('\n· empty friends list');
  const emptyList = await app.fetchJson('/api/v1/friends', { headers: authHeaders(aarya.token) });
  check('list -> 200', emptyList.status === 200);
  if (isSuccess<unknown[]>(emptyList.body)) {
    check('list empty initially', emptyList.body.data.length === 0);
  }

  console.log('\n· search by handle, name, phone');
  const byHandle = await app.fetchJson('/api/v1/friends/search?q=aarav', {
    headers: authHeaders(aarya.token),
  });
  type SearchResult = {
    userId: string;
    name: string;
    handle: string;
    phone: string;
    relationship: string;
    requestId: string | null;
  };
  if (isSuccess<SearchResult[]>(byHandle.body)) {
    check('search by handle returns 1 result', byHandle.body.data.length === 1);
    check(
      'search returns relationship: none initially',
      byHandle.body.data[0]?.relationship === 'none',
    );
    check('search excludes self', byHandle.body.data.every((r) => r.userId !== aarya.userId));
  }
  const byName = await app.fetchJson('/api/v1/friends/search?q=Meera', {
    headers: authHeaders(aarya.token),
  });
  if (isSuccess<SearchResult[]>(byName.body)) {
    check('search by name returns Meera', byName.body.data.some((r) => r.handle === 'meera'));
  }
  // Aarya searches "9876" — matches both Aarya (+919876512345 — excluded as
  // self) and Aarav (+919876543210). Self-exclusion → exactly 1 result.
  const byPhone = await app.fetchJson('/api/v1/friends/search?q=9876', {
    headers: authHeaders(aarya.token),
  });
  if (isSuccess<SearchResult[]>(byPhone.body)) {
    check(
      'search by phone substring matches phone digits and excludes self',
      byPhone.body.data.length === 1 &&
        byPhone.body.data[0]?.handle === 'aarav',
      byPhone.body.data,
    );
  }
  const tooShort = await app.fetchJson('/api/v1/friends/search?q=a', {
    headers: authHeaders(aarya.token),
  });
  check('search with q too short -> 422', tooShort.status === 422);

  console.log('\n· send request: self-rejection');
  const selfReq = await app.fetchJson('/api/v1/friends/request', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({ targetUserId: aarya.userId }),
  });
  check('self-request -> 400', selfReq.status === 400);

  console.log('\n· send request to non-existent user -> 404');
  const ghostReq = await app.fetchJson('/api/v1/friends/request', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({ targetUserId: '00000000-0000-0000-0000-000000000000' }),
  });
  check('non-existent target -> 404', ghostReq.status === 404);

  console.log('\n· aarya → aarav: send request');
  const r1 = await app.fetchJson('/api/v1/friends/request', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({ targetUserId: aarav.userId, message: 'hey aarav!' }),
  });
  check('send -> 201', r1.status === 201, r1.body);
  type RequestDto = {
    id: string;
    direction: 'incoming' | 'outgoing';
    status: string;
    counterparty: { userId: string };
    message: string | null;
  };
  const requestId = isSuccess<RequestDto>(r1.body) ? r1.body.data.id : '';
  if (isSuccess<RequestDto>(r1.body)) {
    check('direction=outgoing for sender', r1.body.data.direction === 'outgoing');
    check('status=PENDING', r1.body.data.status === 'PENDING');
    check('counterparty is aarav', r1.body.data.counterparty.userId === aarav.userId);
    check('message echoed', r1.body.data.message === 'hey aarav!');
  }

  console.log('\n· duplicate send: idempotent return of existing pending row');
  const r1again = await app.fetchJson('/api/v1/friends/request', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({ targetUserId: aarav.userId }),
  });
  check('duplicate send -> 201', r1again.status === 201);
  if (isSuccess<RequestDto>(r1again.body)) {
    check('duplicate returns same request id', r1again.body.data.id === requestId);
  }

  console.log('\n· reverse-direction conflict: aarav cannot send to aarya now');
  const reverse = await app.fetchJson('/api/v1/friends/request', {
    method: 'POST',
    headers: authHeaders(aarav.token),
    body: JSON.stringify({ targetUserId: aarya.userId }),
  });
  check('reverse -> 409', reverse.status === 409);
  check(
    'reverse error message hints at incoming',
    isError(reverse.body) && /accept it instead/.test(reverse.body.error.message),
    reverse.body,
  );

  console.log('\n· search now shows relationship state');
  const aaryaSearch = await app.fetchJson('/api/v1/friends/search?q=aarav', {
    headers: authHeaders(aarya.token),
  });
  if (isSuccess<SearchResult[]>(aaryaSearch.body)) {
    const r = aaryaSearch.body.data[0];
    check('aarya search: outgoing relationship', r?.relationship === 'request_outgoing');
    check('aarya search: requestId present', r?.requestId === requestId);
  }
  const aaravSearch = await app.fetchJson('/api/v1/friends/search?q=aarya', {
    headers: authHeaders(aarav.token),
  });
  if (isSuccess<SearchResult[]>(aaravSearch.body)) {
    check(
      'aarav search: incoming relationship',
      aaravSearch.body.data[0]?.relationship === 'request_incoming',
    );
  }

  console.log('\n· list /friends/requests for both sides');
  const aaryaRequests = await app.fetchJson('/api/v1/friends/requests', {
    headers: authHeaders(aarya.token),
  });
  type RequestList = { incoming: RequestDto[]; outgoing: RequestDto[] };
  if (isSuccess<RequestList>(aaryaRequests.body)) {
    check('aarya outgoing has 1', aaryaRequests.body.data.outgoing.length === 1);
    check('aarya incoming empty', aaryaRequests.body.data.incoming.length === 0);
  }
  const aaravRequests = await app.fetchJson('/api/v1/friends/requests', {
    headers: authHeaders(aarav.token),
  });
  if (isSuccess<RequestList>(aaravRequests.body)) {
    check('aarav incoming has 1', aaravRequests.body.data.incoming.length === 1);
    check('aarav outgoing empty', aaravRequests.body.data.outgoing.length === 0);
  }

  console.log('\n· accept ownership: only receiver can act');
  const wrongAccept = await app.fetchJson(`/api/v1/friends/request/${requestId}/accept`, {
    method: 'POST',
    headers: authHeaders(aarya.token), // sender
  });
  check('sender cannot accept -> 403', wrongAccept.status === 403);
  const thirdParty = await app.fetchJson(`/api/v1/friends/request/${requestId}/accept`, {
    method: 'POST',
    headers: authHeaders(meera.token),
  });
  check('third party cannot accept -> 403', thirdParty.status === 403);

  console.log('\n· accept request');
  const accept = await app.fetchJson(`/api/v1/friends/request/${requestId}/accept`, {
    method: 'POST',
    headers: authHeaders(aarav.token),
  });
  check('accept -> 200', accept.status === 200, accept.body);
  if (isSuccess<RequestDto>(accept.body)) {
    check('status=ACCEPTED', accept.body.data.status === 'ACCEPTED');
  }

  console.log('\n· canonical friendship row created (single, lex-sorted)');
  const friendshipRows = Array.from(app.store.friendships.values());
  check('exactly 1 friendship row', friendshipRows.length === 1);
  if (friendshipRows[0]) {
    check(
      'canonical pair: userAId < userBId',
      friendshipRows[0].userAId < friendshipRows[0].userBId,
      friendshipRows[0],
    );
    const pair = [aarya.userId, aarav.userId].sort();
    check(
      'pair matches the two users',
      friendshipRows[0].userAId === pair[0] && friendshipRows[0].userBId === pair[1],
    );
  }

  console.log('\n· /friends list shows the OTHER user (not self)');
  const aaryaList = await app.fetchJson('/api/v1/friends', { headers: authHeaders(aarya.token) });
  type FriendDto = { userId: string; handle: string; since: string };
  if (isSuccess<FriendDto[]>(aaryaList.body)) {
    check('aarya has 1 friend', aaryaList.body.data.length === 1);
    check('aarya sees aarav (not herself)', aaryaList.body.data[0]?.userId === aarav.userId);
    check('aarya friend handle = aarav', aaryaList.body.data[0]?.handle === 'aarav');
  }
  const aaravList = await app.fetchJson('/api/v1/friends', { headers: authHeaders(aarav.token) });
  if (isSuccess<FriendDto[]>(aaravList.body)) {
    check('aarav has 1 friend', aaravList.body.data.length === 1);
    check('aarav sees aarya (not himself)', aaravList.body.data[0]?.userId === aarya.userId);
  }

  console.log('\n· search after accept: relationship=friend');
  const afterAccept = await app.fetchJson('/api/v1/friends/search?q=aarav', {
    headers: authHeaders(aarya.token),
  });
  if (isSuccess<SearchResult[]>(afterAccept.body)) {
    check('relationship = friend after accept', afterAccept.body.data[0]?.relationship === 'friend');
    check('requestId reset to null', afterAccept.body.data[0]?.requestId === null);
  }

  console.log('\n· cannot send request to existing friend');
  const dupFriend = await app.fetchJson('/api/v1/friends/request', {
    method: 'POST',
    headers: authHeaders(aarya.token),
    body: JSON.stringify({ targetUserId: aarav.userId }),
  });
  check('request to friend -> 409', dupFriend.status === 409, dupFriend.body);

  console.log('\n· accept already-accepted -> 409');
  const acceptAgain = await app.fetchJson(`/api/v1/friends/request/${requestId}/accept`, {
    method: 'POST',
    headers: authHeaders(aarav.token),
  });
  check('accept on accepted -> 409', acceptAgain.status === 409);

  console.log('\n· reject flow: meera → kabir');
  const r2 = await app.fetchJson('/api/v1/friends/request', {
    method: 'POST',
    headers: authHeaders(meera.token),
    body: JSON.stringify({ targetUserId: kabir.userId }),
  });
  const r2Id = isSuccess<RequestDto>(r2.body) ? r2.body.data.id : '';
  check('meera->kabir send -> 201', r2.status === 201);

  const wrongReject = await app.fetchJson(`/api/v1/friends/request/${r2Id}/reject`, {
    method: 'POST',
    headers: authHeaders(meera.token), // sender, not receiver
  });
  check('sender cannot reject -> 403', wrongReject.status === 403);

  const reject = await app.fetchJson(`/api/v1/friends/request/${r2Id}/reject`, {
    method: 'POST',
    headers: authHeaders(kabir.token),
  });
  check('receiver reject -> 200', reject.status === 200);
  if (isSuccess<RequestDto>(reject.body)) {
    check('status=DECLINED', reject.body.data.status === 'DECLINED');
  }

  console.log('\n· reopen: meera → kabir (was declined) creates no duplicate, just reopens');
  const reopen = await app.fetchJson('/api/v1/friends/request', {
    method: 'POST',
    headers: authHeaders(meera.token),
    body: JSON.stringify({ targetUserId: kabir.userId, message: 'try again' }),
  });
  check('reopen -> 201', reopen.status === 201);
  if (isSuccess<RequestDto>(reopen.body)) {
    check('reopen reuses same request id', reopen.body.data.id === r2Id);
    check('reopen status back to PENDING', reopen.body.data.status === 'PENDING');
    check('reopen carries new message', reopen.body.data.message === 'try again');
  }
  const totalRequests = app.store.friendRequests.size;
  check(
    'no duplicate request rows after reopen',
    totalRequests === 2,
    { totalRequests },
  );

  console.log('\n· reject on a request not addressed to me -> 403');
  const stranger = await signIn(app, '+919999999999', { name: 'Riya', handle: 'riya' });
  const otherReject = await app.fetchJson(`/api/v1/friends/request/${r2Id}/reject`, {
    method: 'POST',
    headers: authHeaders(stranger.token),
  });
  check('non-receiver reject -> 403', otherReject.status === 403);

  console.log('\n· accept on unknown request -> 404');
  const ghostAccept = await app.fetchJson(
    `/api/v1/friends/request/00000000-0000-0000-0000-000000000000/accept`,
    { method: 'POST', headers: authHeaders(aarya.token) },
  );
  check('unknown request -> 404', ghostAccept.status === 404);

  console.log('\n· bad UUID param -> 422');
  const badUuid = await app.fetchJson('/api/v1/friends/request/not-a-uuid/accept', {
    method: 'POST',
    headers: authHeaders(aarya.token),
  });
  check('bad UUID -> 422', badUuid.status === 422);

  await app.close();

  if (failures > 0) {
    console.error(`\n✘ ${String(failures)} check(s) failed`);
    process.exit(1);
  }
  console.log('\n✔ all friend flows pass');
}

main().catch((err: unknown) => {
  console.error('friend-smoke crashed:', err);
  process.exit(1);
});
