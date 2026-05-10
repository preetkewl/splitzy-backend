# Database schema — design notes

> Authoritative source: [`prisma/schema.prisma`](../prisma/schema.prisma). This document explains *why* the schema looks the way it does.

## Goals

1. **Source of truth for balances and settlements.** Never trust client-side numbers; the API recomputes from rows.
2. **Mirror the Flutter contract** so the existing [`SplitRepository`](../../splitzy/lib/data/repository.dart) interface fits the new data flow without churn.
3. **Production-ready, MVP-shaped.** Indexed for the queries we'll actually run; no enterprise abstractions we don't need yet.

## Entity overview

```
                ┌──────────┐     ┌──────────────────┐
                │  users   │1───*│  refresh_tokens  │
                └─────┬────┘     └──────────────────┘
                      │
       ┌──────────────┼─────────────────┬──────────────────┐
       │              │                 │                  │
       │1            *│             owns│                 *│
   *┌──┴──┐     ┌─────┴───────┐     ┌───┴──┐         ┌─────┴────────┐
    │trips│1 ──*│trip_members │     │trips │ ─── … (same node)
    └──┬──┘     └─────────────┘     └──────┘
       │1
       │
      *│
   ┌───┴────┐1 ──*┌─────────────────────┐
   │expenses│      │ expense_participants│
   └───┬────┘     └──────────┬──────────┘
       │                     │*
       │                     ▼
       │                  ┌──────┐
       │                  │users │
       │                  └──────┘
       │1
       │
      *▼
   ┌───────────┐
   │settlements│
   └───────────┘

      friend_requests  (from_user → to_user, status)
      friendships      (canonical userA < userB)
```

## Modeling decisions

### 1. `User` is the authoritative identity — `Friend` is a derived view

The Flutter `Friend` model is a *projection* of another `User` from the current user's perspective: name + handle + avatar color from the user record, plus `status` and `mutuals` derived from `Friendship` / `FriendRequest`. Storing `Friend` as a table would denormalize the same fields that already live on `User`. So:

- `User` holds the canonical `name`, `handle`, `phone`, `avatarColor`, `upiId`.
- `Friendship` and `FriendRequest` hold only the relationship.
- `mutuals` is computed at query time (`COUNT(*)` over the friend graph).

### 2. Trip membership is a real table, not a `String[]` column

The Flutter client stores `Trip.memberIds: List<String>` because Hive has no joins. Postgres does — `trip_members` gives us:

- Cheap "trips for user X" via the `(user_id)` index.
- Per-member metadata (role, joined-at) without schema churn.
- Referential integrity: removing a user from a trip is a single row delete; the bridge can never disagree with the user table.

`TripMemberRole` is `OWNER | MEMBER`. Today only the trip creator is `OWNER`; the column is in place so promotions/demotions ship without migration.

### 3. Expenses normalize the split into `expense_participants`

Even though MVP only supports `EQUAL` splits, splits are stored explicitly. Reasons:

- The frontend's net-balance algo iterates `(expense, member, share)` triples — the table *is* that triple, indexed and queryable directly via SQL aggregates.
- Future split modes (`EXACT`, `PERCENT`, `SHARES`) ship by toggling `splitType` and inserting different `sharePaise` values; the read path doesn't change.
- We can answer "what does user X owe across all their trips?" with a single indexed aggregate over `expense_participants(user_id)` — that query would be impossible against a `String[]` column.

The invariant is: `SUM(participants.sharePaise) == expense.amountPaise`. The `computeEqualShares` helper enforces this exactly (the payer absorbs the floor-division remainder, identical to [`balances.dart`](../../splitzy/lib/services/balances.dart)).

### 4. `Settlement` is a separate table (not a flag on `Expense`)

Suggested transfers are a *function* of expenses + prior settlements, not data. But once a user clicks "Mark as paid via UPI" in the [settle screen](../../splitzy/lib/screens/settle_screen.dart), that's a real money movement and gets persisted as a Settlement row. Status enum (`PENDING | COMPLETED | CANCELLED`) exists so a future "intent before pay" UX (or async UPI confirmation) ships without schema work.

The greedy debt-simplification stays in code, not in the database — it would need recomputing on every read anyway.

### 5. `Friendship` uses a canonical pair

A friendship between A and B is the same edge as B and A. Storing it twice doubles writes and creates the possibility of one row drifting from the other. Instead:

- One row per pair, `userAId < userBId` (lexicographic on UUIDs).
- Unique on `(userAId, userBId)` prevents duplicates.
- The [`canonicalFriendshipPair`](../src/database/helpers.ts) helper is the only correct way to compute the pair before write or lookup.

### 6. `FriendRequest` is kept *after* acceptance for audit

When a request is accepted, we insert a `Friendship` row and update the request's `status = ACCEPTED, respondedAt = now()`. We don't delete the request — it's a useful audit trail and keeps the `(fromUserId, toUserId)` unique index from accepting a duplicate "re-friend → unfriend → re-request" cycle as a fresh row.

### 7. Soft delete only where users would expect "trash"

| Model                   | Soft delete? | Why                                                                  |
| ----------------------- | ------------ | -------------------------------------------------------------------- |
| `User`                  | yes          | Account deletion is reversible; settlement history must survive.     |
| `Trip`                  | yes          | "Delete trip" is undoable in most apps.                              |
| `Expense`               | yes          | Frequent edits/deletes; users want undo.                             |
| `TripMember`            | no           | Either you're in or you're out; settlement math can't tolerate ghosts. |
| `ExpenseParticipant`    | no           | Tied to expense lifecycle; cascades.                                 |
| `Settlement`            | no           | `status = CANCELLED` is the soft-delete equivalent.                  |
| `FriendRequest`         | no           | `status` enum carries history.                                       |
| `Friendship`            | no           | Unfriend is intentional; cascade on user delete.                     |
| `RefreshToken`          | no           | `revokedAt` already covers it.                                       |

### 8. Cascade rules

- `Trip → TripMember, Expense, Settlement`: **CASCADE.** Deleting a trip should clean its joins.
- `Expense → ExpenseParticipant`: **CASCADE.** Participants only exist via their expense.
- `User → everything`: **RESTRICT.** Hard-delete is forbidden; soft-delete (`deletedAt`) preserves history. Only `RefreshToken` and `Friendship`/`FriendRequest` cascade because those are user-scoped session/social state, not financial history.

## Indexing

Every index ships for a query we know we'll run, not for "future-proofing":

| Index                                              | Query it serves                                         |
| -------------------------------------------------- | ------------------------------------------------------- |
| `users.phone` UNIQUE                               | Phone-based login.                                      |
| `users.handle` UNIQUE                              | Friend search by `@handle`.                             |
| `users.email` UNIQUE                               | OAuth login.                                            |
| `users.name`                                       | Friend search by display name (LIKE).                   |
| `users.deletedAt`                                  | Exclude soft-deleted from every list.                   |
| `refresh_tokens.tokenHash` UNIQUE                  | Token verification on every refresh call.               |
| `refresh_tokens.userId`                            | "List my active sessions" + bulk revoke.                |
| `refresh_tokens.expiresAt`                         | Cleanup job for expired tokens.                         |
| `trip_members(tripId, userId)` UNIQUE              | One membership per user per trip.                       |
| `trip_members.userId`                              | "My trips" — the home screen's primary query.           |
| `trips.createdById`, `trips.deletedAt`             | Owner queries; soft-delete filter.                      |
| `expenses(tripId, spentAt DESC)`                   | Trip detail screen — listing expenses date-grouped.     |
| `expenses.paidById`                                | "What I paid" history.                                  |
| `expense_participants(expenseId, userId)` UNIQUE   | Prevents duplicate share rows.                          |
| `expense_participants.userId`                      | "What I owe across all trips."                          |
| `settlements(tripId, status)`                      | Settlement history filtered by status per trip.         |
| `settlements.fromUserId`, `settlements.toUserId`   | "Where did my money go / come from."                    |
| `friend_requests(fromUserId, toUserId)` UNIQUE     | Prevent duplicate requests.                             |
| `friend_requests(toUserId, status)`                | "Incoming pending" — friend requests screen tab.        |
| `friend_requests(fromUserId, status)`              | "Sent" — same screen, other tab.                        |
| `friendships(userAId, userBId)` UNIQUE             | Canonical pair uniqueness.                              |
| `friendships.userBId`                              | Reverse lookup when user appears as B in the pair.      |

## Scaling considerations

1. **No materialized balances yet.** Net balances are recomputed from `(expenses, expense_participants, settlements)`. With proper indexes this stays fast up to several hundred expenses per trip — well past MVP. If a hot trip ever hurts, we add a `trip_balances` table updated transactionally on expense write.
2. **UUIDs over auto-increment ints.** UUIDs are mobile-app-friendly (offline ID generation, no race), and they don't leak business volume from monotonic counters.
3. **Money as `Int` paise.** Postgres `INTEGER` is 32-bit signed (≈ ₹2.1 billion ceiling per row) — far above any plausible single-expense value. We can lift to `BigInt` later by widening the column; the API contract is JSON ints either way.
4. **Composite indexes match access patterns.** `(tripId, spentAt DESC)` is the exact shape of the trip-detail listing query, so Postgres returns rows already sorted without a separate sort pass.
5. **Restrict-on-user-delete keeps the financial graph intact.** Soft-deleting a user preserves their expenses, participations, and settlements — required for everyone *else* to keep their balances correct.

## Future extensions (already supported)

- **More split modes**: flip `expense.splitType`, write different `sharePaise` values. No migration.
- **Multi-currency**: add `currency` (varchar 3) on `Expense` and `Settlement`. No relation changes.
- **Recurring expenses**: add `Expense.recurrenceRule` + `parentExpenseId`. No relation changes.
- **Group ownership** (multiple admins): `TripMemberRole` already supports `OWNER | MEMBER`; promote any row.
- **Settlement intents** before payment: use `SettlementStatus.PENDING` and a webhook to flip to `COMPLETED`.
- **Per-user privacy**: `User.deletedAt` lets us anonymize an account without losing the financial graph.
