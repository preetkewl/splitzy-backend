# syntax=docker/dockerfile:1.7

# ─── Stage 1: dependencies ───────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# `openssl` and `libc6-compat` are required by the Prisma engine binaries
# on Alpine. Pinning them here keeps the runtime image deterministic.
RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json* ./
COPY prisma ./prisma
# `--ignore-scripts` skips husky's `prepare` hook (no .git in the build context).
RUN npm ci --ignore-scripts


# ─── Stage 2: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npx prisma generate
RUN npm run build
# NOTE: dev deps (prisma CLI, tsx) are kept in the runtime image so the
# entrypoint can run `prisma db push` and `npm run db:seed` on startup.


# ─── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Build-time release identifier. Surfaced by GET /api/v1/health.
# CI plumbs this in via `--build-arg SERVICE_VERSION=$(git rev-parse --short HEAD)`.
ARG SERVICE_VERSION=unknown
ENV SERVICE_VERSION=${SERVICE_VERSION}

ENV NODE_ENV=production
ENV PORT=4000

# tini supervises PID 1 so SIGTERM forwards to node and zombies are reaped.
# Non-root user is the standard hardening.
RUN apk add --no-cache openssl libc6-compat tini \
    && addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./package.json
# src/ is needed at runtime so `tsx prisma/seed.ts` can resolve its
# `../src/...` imports during one-off seeding.
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/scripts/render-entrypoint.sh ./scripts/render-entrypoint.sh

USER app

EXPOSE 4000

# Container-level liveness — independent of the orchestrator's probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/bin/sh", "/app/scripts/render-entrypoint.sh"]
