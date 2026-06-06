-- V3: append-only Activity feed.
--
-- Single-table, fan-out-on-write model: ONE row per (recipient, event). An
-- event seen by N users writes N rows; the actor is included as a recipient so
-- the feed doubles as a personal history. Purely additive — no existing table
-- is touched, so this is safe to deploy ahead of any application code.
--
-- The table is immutable from the app's perspective (insert-only). The only
-- deletions are FK cascades when a recipient/actor/trip is hard-deleted.
--
-- Reset path (closed testing — data is disposable):
--   npx prisma migrate reset --force

-- ── Enums ─────────────────────────────────────────────────────────────────────

CREATE TYPE "ActivityType" AS ENUM (
    'EXPENSE_ADDED',
    'SETTLEMENT_COMPLETED',
    'FRIEND_ACCEPTED',
    'MEMBER_ADDED',
    'GROUP_CREATED'
);

CREATE TYPE "ActivityEntityType" AS ENUM (
    'EXPENSE',
    'SETTLEMENT',
    'TRIP',
    'USER'
);

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE "activities" (
    "id"          UUID                 NOT NULL DEFAULT gen_random_uuid(),
    -- Recipient — whose feed this row belongs to (fan-out target).
    "user_id"     UUID                 NOT NULL,
    -- Actor — who performed the action (may equal user_id).
    "actor_id"    UUID                 NOT NULL,
    "type"        "ActivityType"       NOT NULL,
    -- Deep-link subject (the entity to open on tap) + analytics dimension.
    "entity_type" "ActivityEntityType" NOT NULL,
    "entity_id"   UUID,
    -- Surrounding trip context. NULL for FRIEND_ACCEPTED.
    "trip_id"     UUID,
    -- Denormalized render snapshot (actor name, trip name, amount, …).
    "metadata"    JSONB                NOT NULL,
    "created_at"  TIMESTAMPTZ          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- The one index that serves the entire feed query: WHERE user_id = $1
-- ORDER BY created_at DESC, id DESC + keyset LIMIT, straight from the index.
CREATE INDEX "activities_user_id_created_at_id_idx"
    ON "activities" ("user_id", "created_at" DESC, "id");

-- Keeps trip hard-delete cascade from sequential-scanning this table.
CREATE INDEX "activities_trip_id_idx" ON "activities" ("trip_id");

-- ── Foreign keys ──────────────────────────────────────────────────────────────

ALTER TABLE "activities"
    ADD CONSTRAINT "activities_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "activities"
    ADD CONSTRAINT "activities_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "activities"
    ADD CONSTRAINT "activities_trip_id_fkey"
    FOREIGN KEY ("trip_id") REFERENCES "trips" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
