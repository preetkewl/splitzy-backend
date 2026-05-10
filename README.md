# Splitzy Backend

Backend API for **Splitzy** — split trip expenses among friends. Built to serve the Flutter client at [`../splitzy`](../splitzy).

> Status: **Step 8 — MVP launch-ready.** All modules complete; production-hardened; documented field-by-field against the Flutter client. Final integration audit and cleanup pass done. **287 integration assertions passing across 8 smoke suites.**
>
> **Companion docs**: [`docs/PROJECT_SUMMARY.md`](docs/PROJECT_SUMMARY.md) · [`docs/api-contract.md`](docs/api-contract.md) (Flutter ↔ backend field mapping) · [`docs/architecture.md`](docs/architecture.md) · [`docs/schema.md`](docs/schema.md) · [`docs/openapi/`](docs/openapi/)

---

## Tech stack

| Layer        | Choice                              |
| ------------ | ----------------------------------- |
| Runtime      | Node.js 20+                         |
| Language     | TypeScript (strict)                 |
| HTTP         | Express 4                           |
| Database     | PostgreSQL 16                       |
| ORM          | Prisma                              |
| Validation   | Zod                                 |
| Auth (later) | JWT (`jsonwebtoken`)                |
| Logging      | Pino + Morgan                       |
| Security     | Helmet, CORS, express-rate-limit    |
| Tooling      | ESLint, Prettier, Husky, lint-staged |
| Container    | Docker + Docker Compose             |

---

## Project layout

```
backend/
├── prisma/
│   └── schema.prisma            # DB schema (models added in later steps)
├── src/
│   ├── app.ts                   # Express app factory (middleware + routes)
│   ├── server.ts                # Bootstrap: connect DB, listen, graceful shutdown
│   ├── config/                  # Env loader + Zod-validated config singleton
│   ├── constants/               # HTTP status codes, error codes
│   ├── core/                    # ApiResponse, ApiError, asyncHandler
│   ├── database/                # Prisma client singleton
│   ├── middlewares/             # cors, helmet, rate-limit, logger, validate, errors
│   ├── modules/                 # Feature modules — one folder per bounded context
│   │   └── health/
│   │       ├── controller/      # Thin HTTP layer
│   │       ├── service/         # Business logic
│   │       └── routes/          # Express sub-router
│   ├── routes/                  # Top-level /api/v1 router (mounts modules)
│   ├── types/                   # Express augmentations + shared types
│   └── utils/                   # logger
├── docs/                        # Architecture notes
├── docker-compose.yml
├── Dockerfile
├── .env.example
└── tsconfig.json
```

### The module template

Every feature module follows the same shape so new ones are mechanical to add:

```
modules/<name>/
├── controller/      # HTTP handlers — parse req, call service, return ApiResponse
├── service/         # Use-case orchestration — pure business logic
├── repository/      # Data access via Prisma — no business logic
├── routes/          # Express sub-router; mounts controllers
├── dto/             # Cross-layer data shapes
├── validation/      # Zod schemas for request bodies / params / query
├── mapper/          # DB ↔ DTO transformations
└── types/           # Module-internal types
```

The `health` module ships only with `controller`, `service`, and `routes` because it doesn't touch any models — use it as the minimum reference.

---

## Getting started

### 1. Prerequisites

- Node.js ≥ 20
- Docker + Docker Compose (recommended) **or** a local PostgreSQL 16

### 2. Install

```bash
cd backend
cp .env.example .env
npm install
```

### 3. Run PostgreSQL

The simplest path is Docker Compose, which provisions Postgres on `localhost:5432`:

```bash
docker compose up -d postgres
```

### 4. Apply the schema

```bash
# First migration — creates all tables
npm run prisma:migrate

# Re-generate the typed client (also runs automatically after migrate)
npm run prisma:generate
```

### 5. Seed sample data

Loads the same Goa-trip fixture the Flutter client ships with (4 users, 1 trip, 6 expenses with equal-split participants, 3 friendships):

```bash
npm run db:seed
```

To wipe and re-apply migrations + seed in one shot:

```bash
npm run db:reset
```

### 6. Start the dev server

```bash
npm run dev
```

The server listens on `http://localhost:4000`. Health endpoint:

```bash
curl http://localhost:4000/api/v1/health
curl http://localhost:4000/api/v1/health/ready   # also checks DB
```

---

## NPM scripts

| Script               | What it does                                       |
| -------------------- | -------------------------------------------------- |
| `npm run dev`        | Start the server with `tsx watch` (hot reload)     |
| `npm run build`      | Type-check, emit JS, rewrite path aliases          |
| `npm start`          | Run the compiled server (`dist/server.js`)         |
| `npm run typecheck`  | `tsc --noEmit`                                     |
| `npm run lint`       | ESLint                                             |
| `npm run lint:fix`   | ESLint with `--fix`                                |
| `npm run format`     | Prettier write                                     |
| `npm run format:check` | Prettier check                                   |
| `npm run prisma:generate` | Regenerate Prisma client                      |
| `npm run prisma:migrate`  | Create + apply a dev migration                |
| `npm run prisma:deploy`   | Apply pending migrations (production)         |
| `npm run prisma:studio`   | Open Prisma Studio                            |
| `npm run db:seed`         | Run `prisma/seed.ts` (idempotent)             |
| `npm run db:reset`        | `prisma migrate reset --force` (drops + reseeds) |

---

## Database schema

Defined in [prisma/schema.prisma](prisma/schema.prisma). Tables (Postgres names in `snake_case`):

| Table                  | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `users`                | Account record; `phone` and `handle` are unique.                |
| `refresh_tokens`       | Server-side rotating refresh tokens (SHA-256 hashed).           |
| `trips`                | A shared spending context.                                      |
| `trip_members`         | Bridge: which users are part of which trip + role.              |
| `expenses`             | One spend event in a trip; amount in paise; category enum.      |
| `expense_participants` | Per-participant share of an expense (∑shares = expense amount). |
| `settlements`          | Persisted money movement between two trip members.              |
| `friend_requests`      | Directional pending request; status enum.                       |
| `friendships`          | Bidirectional friendship; canonical `userAId < userBId`.        |

Conventions:
- **UUID primary keys** everywhere (`@db.Uuid`, app-generated via `@default(uuid())`).
- **Money is integer paise** (₹1 = 100 paise) — never floats.
- **Soft-delete** (`deletedAt`) on `users`, `trips`, `expenses` only.
- **Timestamps** (`createdAt`, `updatedAt`) on every model.
- Cascade behavior: trips cascade to members/expenses/settlements; expenses cascade to participants. User deletion is `Restrict` — soft-delete users instead.

See [docs/schema.md](docs/schema.md) for the full design rationale (normalization, indexes, scaling notes).

## Auth API

Six endpoints under `/api/v1/auth`:

| Method | Path             | Auth | Purpose                                                         |
| ------ | ---------------- | ---- | --------------------------------------------------------------- |
| POST   | `/auth/login`    | —    | Start OTP challenge for a phone (returns `challengeToken`)      |
| POST   | `/auth/verify`   | —    | Submit OTP + challenge → issue access + refresh tokens          |
| POST   | `/auth/refresh`  | —    | Rotate refresh token; old one becomes single-use                |
| POST   | `/auth/logout`   | —    | Revoke a refresh token                                          |
| GET    | `/auth/me`       | ✓    | Current user (with `profileComplete` flag)                      |
| PUT    | `/auth/profile`  | ✓    | Update name / handle / avatarColor / upiId / avatarUrl          |

Full spec: [docs/openapi/auth.yaml](docs/openapi/auth.yaml).

## Trips API

Seven endpoints under `/api/v1/trips`. All require `Authorization: Bearer <jwt>`.

| Method | Path                                      | Who          | Purpose                                              |
| ------ | ----------------------------------------- | ------------ | ---------------------------------------------------- |
| POST   | `/trips`                                  | any auth     | Create a trip; creator becomes `OWNER`               |
| GET    | `/trips?page=&pageSize=`                  | any auth     | List trips I'm a member of (sorted updatedAt desc)   |
| GET    | `/trips/:tripId`                          | member       | Trip detail with members + balance summary           |
| PATCH  | `/trips/:tripId`                          | owner        | Partial update of name / emoji / coverColor / desc.  |
| DELETE | `/trips/:tripId`                          | owner        | Soft-delete                                          |
| POST   | `/trips/:tripId/members`                  | owner        | Idempotent add of `userIds[]`                        |
| DELETE | `/trips/:tripId/members/:memberId`        | owner        | Remove a non-owner member                            |

Full spec: [docs/openapi/trips.yaml](docs/openapi/trips.yaml).

Non-members get **404** on detail and mutation routes (not 403) — leaking trip existence to non-members would let an attacker enumerate IDs.

## Expenses + Balances API

Four endpoints; all require `Authorization: Bearer <jwt>`.

| Method | Path                              | Who                | Purpose                                            |
| ------ | --------------------------------- | ------------------ | -------------------------------------------------- |
| POST   | `/expenses`                       | trip member        | Create expense; equal-split is computed server-side |
| GET    | `/trips/:tripId/expenses`         | trip member        | Paged list, sorted `spentAt` desc, with `canDelete`|
| GET    | `/trips/:tripId/balances`         | trip member        | Net balances + suggested settlement transfers      |
| DELETE | `/expenses/:expenseId`            | payer or trip owner| Soft-delete; balances re-derive automatically      |

Full spec: [docs/openapi/expenses.yaml](docs/openapi/expenses.yaml).

### Money & math guarantees

- Amounts are **integer paise** everywhere — never floats.
- Equal split absorbs the floor-division remainder on the payer, so `SUM(participants[*].sharePaise) === amountPaise` is exact.
- The balance endpoint guarantees `SUM(members[*].netPaise) === 0`.
- Suggested transfers are deterministic — same input always returns the same list (greedy minimum-transfer with `userId` lex tie-breaks).

The reusable engine lives at [`src/modules/expense/engine/balance-engine.ts`](src/modules/expense/engine/balance-engine.ts).

## Friends + Requests API

Six endpoints under `/api/v1/friends`. All require `Authorization: Bearer <jwt>`.

| Method | Path                                            | Purpose                                                   |
| ------ | ----------------------------------------------- | --------------------------------------------------------- |
| GET    | `/friends`                                      | Confirmed friendships (the OTHER user, not self)          |
| GET    | `/friends/search?q=`                            | Substring search on name / handle / phone, with state hint |
| GET    | `/friends/requests`                             | Pending incoming + outgoing in one call                   |
| POST   | `/friends/request`                              | Send (idempotent; reopens declined; rejects reverse-pending) |
| POST   | `/friends/request/:requestId/accept`            | Recipient-only; atomic accept + Friendship insert         |
| POST   | `/friends/request/:requestId/reject`            | Recipient-only; status → DECLINED                         |

Full spec: [docs/openapi/friends.yaml](docs/openapi/friends.yaml).

The friend graph is intentionally minimal — no chat, presence, feeds, or recommendations. It exists to make trip-creation member selection one tap. `Friendship` rows are stored once with `userAId < userBId` (canonical pair, see [`src/database/helpers.ts`](src/database/helpers.ts) → `canonicalFriendshipPair`).

## Settlements API

Two endpoints; all require `Authorization: Bearer <jwt>`.

| Method | Path                              | Who         | Purpose                                  |
| ------ | --------------------------------- | ----------- | ---------------------------------------- |
| POST   | `/settlements`                    | trip member | Record a money movement (UPI/CASH/MANUAL) |
| GET    | `/trips/:tripId/settlements`      | trip member | Settlement history, newest first         |

Full spec: [docs/openapi/settlements.yaml](docs/openapi/settlements.yaml).

### Settlement properties

- **Immutable.** No PATCH or DELETE endpoint. Once recorded, a settlement is permanent ledger history.
- **Always written `COMPLETED`** in this step. The `status` enum (PENDING / COMPLETED / CANCELLED) is reserved for future async-UPI flows.
- **`externalRef`** is stored verbatim — reserved for future reconciliation. The server does not verify anything.
- **Methods:** `UPI`, `CASH`, `MANUAL`.

### Balance integration

`GET /trips/:tripId/balances` now subtracts completed settlements from expense-derived balances:

```
net[u] =   SUM(paid as expense payer)
         − SUM(share owed as expense participant)
         + SUM(amount paid as settlement payer)
         − SUM(amount received as settlement receiver)
```

`SUM(net) === 0` is preserved by construction — every settlement adds `+amount` to one user and `−amount` to another.

`totalReimbursedPaise` in the balance response is the running total of completed settlements for the trip.

### Mock OTP

`MockOtpProvider` (the default) accepts **`123456`** as the OTP. In non-production, `/auth/login` echoes the code in `devOtp` so the dev frontend can autofill. To swap in a real provider (Twilio Verify, MSG91, …), implement `OtpProvider` and inject it via `createAuthModule({ otp: ... })`.

### Quick cURL flow

```bash
# 1. Start OTP challenge
curl -s -X POST localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"phone":"+919876512345"}'
# → { success: true, data: { challengeToken: "...", devOtp: "123456" } }

# 2. Verify with the OTP
curl -s -X POST localhost:4000/api/v1/auth/verify \
  -H 'content-type: application/json' \
  -d '{"challengeToken":"<from step 1>","otp":"123456"}'
# → { success: true, data: { user, accessToken, refreshToken, ... } }

# 3. Use the access token
curl -s localhost:4000/api/v1/auth/me \
  -H "Authorization: Bearer <accessToken>"

# 4. Rotate refresh token
curl -s -X POST localhost:4000/api/v1/auth/refresh \
  -H 'content-type: application/json' \
  -d '{"refreshToken":"<refreshToken>"}'

# 5. Sign out
curl -s -X POST localhost:4000/api/v1/auth/logout \
  -H 'content-type: application/json' \
  -d '{"refreshToken":"<refreshToken>"}'
```

## API conventions

Every JSON response uses one envelope shape:

```json
// success
{ "success": true, "data": { ... }, "meta": { ... } }

// error
{ "success": false, "error": { "code": "VALIDATION_FAILED", "message": "...", "details": {...} } }
```

- Money is stored and returned as **paise** (`int`), matching the Flutter client. Never floats.
- Base path: `/api/v1`. New major versions get `/api/v2`.
- Errors are produced via `ApiError` (or thrown Zod / Prisma errors) and serialized centrally.

---

## Docker

### Local

Run the full stack (Postgres + API):

```bash
docker compose up --build
```

The image is a multi-stage build: `deps → build (with prisma generate) → runtime` (Node 20-alpine, non-root user, tini as PID 1, container-level `HEALTHCHECK`).

### Production

```bash
cp .env.production.example .env.production    # then fill in DATABASE_URL, JWT_SECRET, CORS_ORIGINS
SERVICE_VERSION=$(git rev-parse --short HEAD) docker compose -f docker-compose.production.yml up -d --build
```

`docker-compose.production.yml` differs from the dev compose:
- Bind ports to `127.0.0.1` only — front via nginx for TLS termination.
- Restart policy `unless-stopped`.
- Container-level healthcheck wraps `/api/v1/health/ready`.
- `SERVICE_VERSION` plumbs through `Dockerfile`'s build arg into the runtime env, surfaced by `/api/v1/health`.

---

## Production deployment (non-Docker, PM2)

For a single-VPS deployment without containers:

```bash
npm ci
npm run build
npm run prisma:deploy          # apply migrations from prisma/migrations/
pm2 start ecosystem.config.cjs --env production
pm2 save && pm2 startup        # persist across reboots
```

`ecosystem.config.cjs` runs the API in cluster mode (one process per CPU). The API is fully stateless — no per-process session store, refresh-token state lives in Postgres — so cluster mode scales linearly on a single host with zero coordination cost. `kill_timeout: 12_000` matches the graceful-shutdown deadline in `src/server.ts` so PM2 doesn't `SIGKILL` mid-drain.

---

## Operations

### Cron-friendly scripts

| Script | Purpose |
| --- | --- |
| `npm run ops:cleanup-tokens -- --days=30` | Drop refresh tokens whose `expiresAt` or `revokedAt` is older than `--days` ago. Idempotent. Use `--dry` to preview. |

Add to a daily cron (or a managed schedule, e.g. Render Cron Jobs / GitHub Actions):

```cron
0 3 * * *  cd /opt/splitzy/backend && npm run ops:cleanup-tokens -- --days=30
```

### Database backup

Postgres-managed services (RDS / Cloud SQL / Neon) handle backups for you. For a self-hosted compose deployment, run `pg_dump` from outside the container:

```bash
docker exec splitzy-postgres-prod pg_dump -U splitzy splitzy \
  | gzip > "splitzy-$(date +%F).sql.gz"
```

### Migrations in production

```bash
npm run prisma:deploy   # applies pending migrations; never resets data
```

Never run `prisma migrate dev` or `db:reset` against a production database — those are dev-only commands.

---

## Observability

- **Structured logs.** Pino emits JSON in production, `pino-pretty` in dev. Every log line carries `service`, `requestId`, `userId` (when authenticated), `path`, `method`, `status`, `durationMs`.
- **Request correlation.** The `requestId` middleware honors an upstream `X-Request-Id` header (after shape validation) or generates a UUID. The id is echoed on the response and threaded through every log line — including the central error handler — so you can pivot from a client-side error to the exact server log.
- **Sensitive-field redaction.** Pino's `redact` config wipes `Authorization` headers, password hashes, refresh tokens, OTPs (incl. `devOtp` and `challengeToken`), and access tokens before serialization — even if a developer accidentally logs them.
- **Health endpoints.**
  - `GET /api/v1/health` — liveness only. Cheap. Surfaces `version`, `environment`, `uptimeSeconds`.
  - `GET /api/v1/health/ready` — adds a Postgres `SELECT 1` for readiness probes. Use this for blue-green flips and orchestrator readiness checks.

---

## Security hardening

| Concern | How it's enforced |
| --- | --- |
| Token theft | Refresh tokens stored as SHA-256 hash, single-use rotation; old token reuse → 401 + log entry |
| OTP brute force | Auth limiter: 10 req/min per IP on `/auth/login` and `/auth/verify`; 100 req/min global on the API surface |
| Input fuzzing | Every endpoint validates body / params / query through Zod; structured 422 with field errors |
| Privilege escalation | Membership / ownership gates run inside the service layer, not just middleware. Trip/Expense/Settlement read paths return **404** for non-members (no enumeration) and **403** for member-but-not-owner mutations |
| Cross-trip leakage | Every write validates that the caller, payer, participants, and counterparties are all members of the named trip — pre-computed once per request from `trip.findDetail` |
| Stack-trace leakage | Production responses for unknown errors return a generic message; full stack stays in the structured log only |
| Header injection | `requestId` middleware shape-validates upstream `X-Request-Id` against `[a-zA-Z0-9_-]{1,64}` |
| Helmet defaults | Default headers; the API doesn't serve HTML so the default CSP is fine |
| `trust proxy` | Set to `1` so `req.ip` reflects the real client behind the LB |
| Body size | `express.json({ limit: '1mb' })` |

---

## Scaling path

1. **Vertical first.** Stateless app + Postgres on a managed plan. Cluster mode (PM2 / `node:cluster` inside Docker) saturates CPU on the single host.
2. **Horizontal API replicas.** Already supported — every request is independent. Add an HTTP load balancer in front, point all replicas at the same Postgres. The only shared state is the DB.
3. **Connection pooling.** When replicas multiply, put PgBouncer (or Prisma Accelerate) between Prisma and Postgres so a fan-out of replicas doesn't blow the Postgres `max_connections`.
4. **Cache layer.** [`src/infrastructure/cache/`](src/infrastructure/cache/) ships an `ICache` interface + an `InMemoryCache` impl. When you scale past one API instance: `npm i ioredis`, drop in a `RedisCache` impl, swap the binding in `src/infrastructure/cache/index.ts`. No call site changes.
5. **Read replicas.** When balance reads dominate, point a read-only Prisma client at a Postgres read replica; the lean projections (`expense.findForBalances`, `settlement.findCompletedForBalances`) are already shaped for it.
6. **Materialized aggregates.** If a single hot trip ever becomes the bottleneck for `/balances`, add a `trip_balances` table updated transactionally on expense + settlement writes. The engine's interfaces are unchanged.

---

## Environment variables

Every variable is validated by Zod at startup ([`src/config/env.ts`](src/config/env.ts)). Missing or malformed values exit the process before the listener binds.

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | — | `development` | `development` / `test` / `production` |
| `PORT` | — | `4000` | API HTTP port |
| `API_PREFIX` | — | `/api/v1` | All routes live under this prefix |
| `DATABASE_URL` | ✅ | — | Postgres connection string |
| `JWT_SECRET` | ✅ | — | ≥ 16 chars; production: 64+ random |
| `JWT_ACCESS_EXPIRES_IN` | — | `15m` | jsonwebtoken duration string |
| `JWT_REFRESH_EXPIRES_IN` | — | `30d` | jsonwebtoken duration string |
| `CORS_ORIGINS` | — | `*` | Comma-separated; never `*` in production |
| `RATE_LIMIT_WINDOW_MS` | — | `60000` | Global API limiter window |
| `RATE_LIMIT_MAX` | — | `100` | Global API limiter cap per window per IP |
| `LOG_LEVEL` | — | `info` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` / `silent` |
| `SERVICE_VERSION` | — | `0.0.0` | Surfaced by `/health`. Set via Dockerfile `ARG` or CI |

Templates: [`.env.example`](./.env.example) (dev), [`.env.production.example`](./.env.production.example) (prod).

---

## Smoke tests

A complete in-memory test harness lives in [`scripts/`](scripts/). Each suite exercises a real Express stack against fake repositories sharing one `FakeStore`, so the same code paths run as in production minus Postgres.

| Suite | Assertions | Covers |
| --- | --- | --- |
| `npm run smoke:http` | end-to-end | 200/404, error envelope shape |
| `npm run smoke:auth` | 28 | login → verify → refresh rotation → logout → re-login idempotency |
| `npm run smoke:trip` | 41 | CRUD, members, ownership gates, 404-vs-403 |
| `npm run smoke:engine` | 53 | `splitEqual`, `computeNetBalances`, `simplify` (incl. settlement-aware) |
| `npm run smoke:regression` | 8 | Backend math vs. Flutter `balances.dart` on the Goa fixture |
| `npm run smoke:expense` | 52 | Equal split, list with `canDelete`, balances, soft-delete |
| `npm run smoke:friend` | 56 | Search, request lifecycle, canonical pair, idempotent send/reopen |
| `npm run smoke:settlement` | 49 | UPI/CASH/MANUAL, immutability, balance reduction, full close-out |
| `npm run smoke:all` | (sum) | Run every suite in sequence |

Total: **287 assertions across 8 suites** at the close of Step 6.
