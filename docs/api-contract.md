# Flutter ↔ Backend API contract

> Authoritative reference for the Flutter `RestSplitRepository` ([`splitzy/lib/data/rest_repository.dart`](../../splitzy/lib/data/rest_repository.dart)). The current Hive-backed repo (`HiveSplitRepository`) is the local fallback; the REST repo replaces it call-for-call. This document maps every Flutter model field and `SplitRepository` method to the backend endpoint, response shape, and serialization rule.

## Global conventions

| Concern | Convention |
| --- | --- |
| **Base URL** | `<host>/api/v1` (configurable via `API_PREFIX`) |
| **Content-Type** | `application/json` for all writes |
| **Auth header** | `Authorization: Bearer <accessToken>` for protected routes |
| **Date/time** | ISO-8601 with timezone (`2024-12-06T10:00:00.000Z`); decode via `DateTime.parse` |
| **IDs** | UUID v4 strings everywhere (`@db.Uuid` server-side) |
| **Money** | Integer paise (₹1 = 100 paise). Never floats. Decode as `int`. |
| **Casing** | camelCase JSON; mirrors the DTO field names verbatim |
| **Envelope** | `{ success: true, data, meta? }` or `{ success: false, error: { code, message, details? } }` |
| **Pagination meta** | `{ page: int, pageSize: int, total: int }` returned alongside every list endpoint |
| **Correlation** | `X-Request-Id` echoed on every response — log it on the client to make support easier |

### Error codes (stable enum)

```
VALIDATION_FAILED · UNAUTHORIZED · FORBIDDEN · NOT_FOUND · CONFLICT
RATE_LIMITED · INTERNAL_ERROR · BAD_REQUEST
INVALID_CREDENTIALS · INVALID_TOKEN · TOKEN_EXPIRED · HANDLE_TAKEN
```

Pivot client-side error UX off `error.code`, not `error.message`. Messages are operational; codes are the contract.

---

## Auth flow

The Flutter login screen calls `signInWithProvider(AuthProvider provider)`. Under the REST repo, that maps to a **two-step phone OTP flow**:

```
1. POST /auth/login    { phone }                       → { challengeToken, expiresAt, devOtp? }
2. POST /auth/verify   { challengeToken, otp }         → { user, accessToken, refreshToken, … }
```

The legacy `signInWithProvider(google|apple|phone)` becomes `signInWithPhone(phone, otp)` once the screen is updated. Mock OTP for dev: `123456` (echoed in `devOtp` when `NODE_ENV != production`).

| Flutter `User` field | Backend `UserDto` field | Notes |
| --- | --- | --- |
| `id` | `id` | UUID instead of `'you'`; the Hive repo's special "you" id no longer exists |
| `name` | `name` | Empty string until profile completion |
| `phone` | `phone` | E.164 (`+919876512345`); read-only after sign-up |
| `upiId` | `upiId` | Nullable |
| `avatarUrl` | `avatarUrl` | Nullable |
| `createdAt` | `createdAt` | ISO-8601 |
| — | `handle` | NEW — auto-generated at sign-up, mutable via `PUT /auth/profile` |
| — | `avatarColor` | NEW — server-picked at sign-up |
| — | `email` | Nullable; reserved for future OAuth |
| — | `profileComplete` | Computed: `name.trim().length ≥ 2`. Drives the `/profile` redirect |

### `SplitRepository` → endpoint mapping

| Flutter call | HTTP | Notes |
| --- | --- | --- |
| `signInWithProvider(...)` | `POST /auth/login` then `POST /auth/verify` | Two-step (challengeToken + otp) |
| `signOut()` | `POST /auth/logout` `{ refreshToken }` | 204 |
| `currentUser()` | `GET /auth/me` | Reads from access token |
| `watchCurrentUser()` | (client-side cache + manual refresh) | No server-push |
| `updateProfile({name, phone, upiId})` | `PUT /auth/profile` | Backend ignores `phone` (read-only); accepts `name`, `handle`, `avatarColor`, `upiId`, `avatarUrl` |

### Token lifecycle

- **Access token**: short-lived JWT (`JWT_ACCESS_EXPIRES_IN`, default 15m). Send on every protected call.
- **Refresh token**: long-lived JWT (`JWT_REFRESH_EXPIRES_IN`, default 30d). Stored hashed server-side, **single-use**: every refresh issues a new pair and revokes the old one. **Persist only the latest** in secure storage on the client.
- **Auto-refresh**: on a 401 with `code: TOKEN_EXPIRED`, call `POST /auth/refresh { refreshToken }`, then retry the original request once.
- **Replay detection**: a 401 with `code: INVALID_TOKEN` on `/auth/refresh` means the refresh token was already used or revoked → force the user back to login.

---

## Trips

### Flutter `Trip` ↔ Backend `TripSummaryDto` / `TripDetailDto`

| Flutter `Trip` | Backend (`TripSummaryDto`) | Notes |
| --- | --- | --- |
| `id` | `id` | UUID |
| `name` | `name` | Same |
| `emoji` | `emoji` | Same |
| `coverColor` | `coverColor` | Hex; server-side palette fallback if omitted on create |
| `memberIds: List<String>` | `members: TripMemberPreviewDto[]` | Map: `members.map((m) => m.userId).toList()` |
| `createdAt` | `createdAt` | ISO-8601 |
| — | `description` | NEW, optional |
| — | `isOwner` | NEW — boolean, computed per viewer |
| — | `memberCount` | NEW |
| — | `totalAmountPaise` | NEW — sum of expenses, server-aggregated |
| — | `latestExpenseAt` | NEW — for "active" sorting |
| — | `updatedAt` | NEW — drives list ordering |

The Detail variant adds `members: TripMemberDto[]` (full info incl. handle + upiId for the settle screen) and `balanceSummary: { totalAmountPaise, settledAmountPaise, pendingAmountPaise }` (placeholder; real numbers via `/trips/:tripId/balances`).

### Endpoint mapping

| Flutter call | HTTP |
| --- | --- |
| `watchTrips()` | `GET /trips?page=&pageSize=` (poll on resume) |
| `createTrip({ name, emoji, memberIds })` | `POST /trips` |
| `getTrip(id)` | `GET /trips/:tripId` |
| (not in current Flutter contract) | `PATCH /trips/:tripId`, `DELETE /trips/:tripId`, `POST /trips/:tripId/members`, `DELETE /trips/:tripId/members/:memberId` |

### Frontend transform notes

- Sort key for the home screen "Active trips": use `latestExpenseAt` (or `updatedAt` if no expenses) instead of insertion order.
- The home overall-balance card sums `members.find((m) => m.userId === currentUserId).netPaise` from `/trips/:tripId/balances` — no client-side computation.

---

## Expenses & balances

The backend is the **single source of truth** for balances. Drop the local `balances.dart` import in production builds.

### Flutter `Expense` ↔ Backend `ExpenseDto`

| Flutter `Expense` | Backend `ExpenseDto` | Notes |
| --- | --- | --- |
| `id` | `id` | UUID |
| `tripId` | `tripId` | UUID |
| `title` | `title` | Same |
| `amount: int` (paise) | `amountPaise: int` | **Field renamed** — explicit unit |
| `paidBy: String` (memberId) | `paidBy: { userId, name, avatarColor, avatarUrl }` | Read `paidBy.userId` for the equivalent |
| `cat: ExpenseCategory` | `category: ExpenseCategory` | **Field renamed**; enum values match: `STAY` / `FOOD` / `TRAVEL` / `FUN` / `MISC` |
| `date: DateTime` | `spentAt: string` | **Field renamed** |
| — | `splitType: 'EQUAL'` | NEW — reserved enum, only `EQUAL` for MVP |
| — | `participants: ExpenseParticipantDto[]` | NEW — server-stored shares (`userId, sharePaise`) |
| — | `canDelete: bool` | NEW — true if viewer is payer or trip owner |
| — | `createdAt`, `updatedAt` | ISO-8601 |

### Endpoint mapping

| Flutter call | HTTP |
| --- | --- |
| `watchExpenses(tripId)` | `GET /trips/:tripId/expenses?page=&pageSize=` |
| `addExpense(e)` | `POST /expenses` `{ tripId, title, amountPaise, paidByUserId, category, spentAt }` |
| (not in Flutter today) | `DELETE /expenses/:expenseId` |
| `balances/transfers from balances.dart` | `GET /trips/:tripId/balances` |

### `BalanceSummaryDto` (the new source of truth)

```jsonc
{
  "totalAmountPaise": 2524000,
  "totalReimbursedPaise": 0,
  "members": [
    {
      "userId": "…",
      "name": "Aarav",
      "avatarColor": "#D4845A",
      "avatarUrl": null,
      "netPaise": 849000,        // > 0: is owed; < 0: owes; 0: settled
      "totalPaidPaise": 1480000,
      "totalSharePaise": 631000,
      "isCurrentMember": true
    }
  ],
  "suggestedTransfers": [        // greedy minimum-transfer; deterministic
    { "fromUserId": "…", "toUserId": "…", "amountPaise": 447000 }
  ]
}
```

### Math guarantees the frontend can rely on

- `SUM(members[*].netPaise) === 0` — always.
- `SUM(participants[*].sharePaise) === amountPaise` — always (per expense).
- For the same input, `suggestedTransfers` is byte-identical across calls.
- Equal-split rule: `floor(amount/n)` for non-payers, payer absorbs the remainder.

---

## Friends & requests

Frontend `Friend` is a *projection* of another `User` from the caller's perspective. Backend separates the user record from the relationship state.

### Flutter `Friend` ↔ Backend payloads

| Flutter `Friend` | Backend (search / list) | Notes |
| --- | --- | --- |
| `id` | `userId` | UUID |
| `name` | `name` | Same |
| `handle` | `handle` | Same |
| `phone` | `phone` (search only) | Excluded from `/friends` list and elsewhere |
| `avatarColor` | `avatarColor` | Same |
| `mutuals: int` | — | Not exposed by MVP backend; future: `friendships` graph join |
| `status: FriendStatus` | derived | See translation below |

**Status translation (per-viewer):**

```dart
// Backend
relationship in /friends/search → FriendSearchResult.relationship:
   'none' | 'friend' | 'request_outgoing' | 'request_incoming'

// Flutter
FriendStatus = pendingOutgoing | pendingIncoming | accepted

// Map
relationship === 'friend'             → FriendStatus.accepted
relationship === 'request_outgoing'   → FriendStatus.pendingOutgoing
relationship === 'request_incoming'   → FriendStatus.pendingIncoming
relationship === 'none'               → not in the friends list at all
```

`FriendRequestDto.direction` (`'incoming' | 'outgoing'`) plus `FriendRequestDto.status` (`'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED'`) drive the Requests screen tabs.

### Endpoint mapping

| Flutter call | HTTP |
| --- | --- |
| `watchFriends()` | `GET /friends?page=&pageSize=` (paginated) |
| `searchDirectory(q)` | `GET /friends/search?q=&limit=` |
| `sendFriendRequest(targetId)` | `POST /friends/request` `{ targetUserId }` |
| `respondToRequest(id, true)` | `POST /friends/request/:requestId/accept` |
| `respondToRequest(id, false)` | `POST /friends/request/:requestId/reject` |

`POST /friends/request` is **idempotent**: posting the same target with a pending request returns the existing row; a previously declined/cancelled request reopens in place.

---

## Settlements

No equivalent in the Hive frontend yet — the existing settle screen was display-only, computing the suggested transfers but never persisting them. The REST integration adds:

| HTTP | Purpose |
| --- | --- |
| `POST /settlements` | Record a payment (UPI / CASH / MANUAL) — immutable |
| `GET /trips/:tripId/settlements?page=&pageSize=` | Settlement history, newest first |

### `SettlementDto` shape

```jsonc
{
  "id": "uuid",
  "tripId": "uuid",
  "amountPaise": 100000,
  "status": "COMPLETED",          // future: PENDING / CANCELLED
  "method": "UPI",                // UPI | CASH | MANUAL
  "fromUser": { "userId": "…", "name": "Aarya", "avatarColor": "#1F8A5B", "avatarUrl": null },
  "toUser":   { "userId": "…", "name": "Aarav", "avatarColor": "#D4845A", "avatarUrl": null },
  "note": "first chunk",
  "externalRef": "TXN1234567",    // optional UPI tx id; not verified server-side
  "settledAt": "2026-05-09T12:34:56.000Z",
  "createdById": "uuid",
  "createdAt": "2026-05-09T12:34:56.000Z"
}
```

### Settle screen flow (recommended)

```
1. GET /trips/:tripId/balances              → suggestedTransfers[]
2. User taps "Pay ₹X via UPI" / "Mark as paid"
3. (UPI) Open url_launcher with `upi://pay?…`
4. POST /settlements
     { tripId, fromUserId: viewer, toUserId: t.toUserId,
       amountPaise: t.amountPaise, method: 'UPI',
       externalRef: <if available> }
5. Refetch /trips/:tripId/balances          → settlement nets out automatically
```

`SUM(net) === 0` is preserved across any sequence of settlements.

---

## Pagination

Every list endpoint accepts `?page=&pageSize=` (`page ≥ 1`, `pageSize ≤ 100`, both server-clamped) and returns:

```jsonc
{
  "success": true,
  "data": [ /* items */ ],
  "meta": { "page": 1, "pageSize": 20, "total": 42 }
}
```

Frontend should track `meta.total` for "load more" UX and `data.length === pageSize` to detect more pages cheaply.

---

## Empty / loading / error UX

Loading and error states map cleanly to the response envelope:

| Server status | UX |
| --- | --- |
| Network error / timeout | Generic "Couldn't connect" + retry button |
| 401 / 403 — `INVALID_TOKEN` / `TOKEN_EXPIRED` | Try refresh once; on second 401 → `/login` |
| 401 — `INVALID_CREDENTIALS` (wrong OTP) | Inline error on the OTP field |
| 404 | "Trip not found" / "User not found" |
| 409 — `HANDLE_TAKEN` | Inline error under the handle input |
| 409 — `CONFLICT` (already friends, etc.) | Show the message; offer alternate action |
| 422 — `VALIDATION_FAILED` | `error.details.fields` is `Record<string, string[]>` keyed by the offending path |
| 429 — `RATE_LIMITED` | Toast: "Too many attempts — try again in a minute" |
| Empty `data: []` | First-run state for the screen (e.g. trip list shows the dashed-card empty state) |

---

## What still differs from the Hive contract

These are the **only** breaking renames a careful Flutter team needs to handle when swapping in `RestSplitRepository`:

| Flutter Hive | Backend | Action |
| --- | --- | --- |
| `Expense.amount` | `Expense.amountPaise` | Read `amountPaise` |
| `Expense.paidBy` (memberId) | `Expense.paidBy.userId` | Read the nested userId |
| `Expense.cat` | `Expense.category` | Rename + same enum values |
| `Expense.date` | `Expense.spentAt` | Rename |
| `Trip.memberIds` | `Trip.members.map(userId)` | Map to the simple list |
| `User.id == 'you'` | UUID | Treat any UUID returned by `/auth/me` as "self"; no special string |
| `Friend.status` | derived from `relationship` / `direction` | See translation table above |

Everything else carries over name-for-name.
