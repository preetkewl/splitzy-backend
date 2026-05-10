# Architecture

Splitzy backend is structured around **clean architecture** with a strict layering rule: **dependencies point inward**. The HTTP layer knows about services; services know about repositories; repositories know about Prisma. Never the other way around.

## Layers

```
┌─────────────────────────────────────────┐
│  routes/  +  modules/*/routes/          │  HTTP routing
├─────────────────────────────────────────┤
│  modules/*/controller/                  │  HTTP boundary (parse, format)
├─────────────────────────────────────────┤
│  modules/*/service/                     │  Use cases / business rules
├─────────────────────────────────────────┤
│  modules/*/repository/                  │  Data access (Prisma)
├─────────────────────────────────────────┤
│  database/  +  prisma/                  │  Persistence
└─────────────────────────────────────────┘
```

### Controller
- Owns the HTTP boundary. Parses validated input from `req`, calls a service, returns an `ApiResponse`.
- **No business logic.** No database calls.
- Wrapped in `asyncHandler` so async failures reach the central error handler.

### Service
- The unit of business behavior. Composable, framework-agnostic.
- Owns transactions, authorization checks, domain invariants.
- Returns DTOs — never raw Prisma rows.

### Repository
- The only place Prisma is referenced (outside infra setup).
- Pure CRUD + domain queries. No service/controller knowledge.

### DTO / Mapper
- DTOs decouple wire format from DB shape — frontend stability outlives schema churn.
- Mappers translate `PrismaModel ↔ DTO`.

---

## Cross-cutting concerns

| Concern         | Where it lives                                    |
| --------------- | ------------------------------------------------- |
| Validation      | `middlewares/validate-request.ts` + module `validation/` |
| Errors          | `core/api-error.ts` + `middlewares/error-handler.ts` |
| Responses       | `core/api-response.ts`                            |
| Logging         | `utils/logger.ts` (Pino) + `middlewares/request-logger.ts` (Morgan) |
| Security        | Helmet (`app.ts`), `middlewares/cors.ts`          |
| Rate limiting   | `middlewares/rate-limit.ts` (mounted at API prefix) |
| Async safety    | `core/async-handler.ts`                           |
| DB lifecycle    | `database/prisma.ts` + `server.ts` shutdown hooks |
| Config          | `config/env.ts` (Zod-validated, frozen singleton) |

---

## Why these choices

### Express (vs. Fastify, NestJS, Hono)
- Massive ecosystem, well understood by all developers.
- Middleware model maps cleanly to clean architecture's cross-cutting concerns.
- Avoids NestJS's heavy DI/decorator runtime — we want explicit wiring.

### Prisma (vs. Drizzle, Knex, TypeORM)
- Schema-first, generated types — strict TS without hand-written interfaces.
- First-class Postgres support, predictable migrations.
- `Prisma.PrismaClientKnownRequestError` codes give us structured handling in the error middleware.

### Zod (vs. Joi, class-validator, Yup)
- Schema *is* the type — no DTO/validation drift.
- Composes well with Express via a tiny `validateRequest` middleware.
- Plays directly with our error envelope (issues → `details.fields`).

### Pino (vs. Winston)
- Fastest production logger, structured JSON by default.
- `pino-pretty` only loaded in non-prod for human-readable dev logs.
- Built-in redaction for auth headers and tokens.

### JWT (vs. sessions)
- Mobile-first product — stateless tokens fit React-Native / Flutter clients.
- Refresh tokens stored server-side (later step) keep us secure and revocable.

---

## Scalability notes

1. **Stateless API.** The process holds no per-user state — horizontal scale = run more containers.
2. **Connection pooling.** Prisma uses Postgres pool by default. Behind PgBouncer in production.
3. **Versioned base path.** `/api/v1` means breaking changes ship as `/api/v2` without disturbing existing clients.
4. **Module isolation.** Each `modules/<name>` folder is independently deployable in spirit — extracting one to its own service is mechanical.
5. **Singleton patterns** (Prisma client, config) survive `tsx` hot reload via `globalThis` cache, so dev never thrashes connections.
6. **Trust-proxy on.** Real client IP / `X-Forwarded-*` honored — required for accurate rate-limit + audit logs behind a load balancer.
7. **Graceful shutdown.** SIGTERM closes the HTTP listener, drains in-flight requests, then disconnects Prisma. Kubernetes / Docker stop semantics.
8. **Multi-stage Docker image.** Slim runtime (`node:20-alpine` + tini, non-root user). Build deps stay out of the final image.

---

## Folder structure rationale

| Folder        | Why it exists                                                  |
| ------------- | -------------------------------------------------------------- |
| `config/`     | Env validation runs once, exits hard on misconfig — fail fast. |
| `constants/`  | Stable enums shared across layers (HTTP, error codes).         |
| `core/`       | Generic application primitives, no domain knowledge.           |
| `database/`   | Persistence wiring kept out of `core/` so a future swap is local. |
| `middlewares/`| Cross-cutting Express handlers, importable by name.            |
| `modules/`    | Vertical slices — each business capability in one folder.      |
| `routes/`     | The single mount-point for the API surface. Easy to audit.     |
| `types/`      | Express augmentations + cross-module types.                    |
| `utils/`      | Stateless helpers (logger today; date/string helpers later).   |
| `docs/`       | This file + future ADRs.                                       |
