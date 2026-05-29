-- Phase 2: normalized payment-schema architecture.
--
-- Replaces the single-payer `paid_by_id` column on `expenses` with a proper
-- many-to-many `expense_payments` join table. This separates the two
-- independent accounting dimensions:
--
--   PAYMENT    → expense_payments.contribution_minor (who paid how much)
--   OBLIGATION → expense_participants.share_minor    (who owes how much)
--
-- Both dimensions independently satisfy:
--   SUM(contribution_minor) per expense = expenses.amount_minor
--   SUM(share_minor)        per expense = expenses.amount_minor
--
-- Migration strategy:
--   1. Create expense_payments with DB-level constraints and indexes.
--   2. Backfill one row per existing expense from paid_by_id / amount_minor.
--      This preserves all balance accounting — a single-payment expense where
--      contributionMinor = amountMinor is identical to the old single-payer model.
--   3. Drop the FK constraint, index, and column for paid_by_id.
--
-- Reset path (closed testing — data is disposable):
--   npx prisma migrate reset --force
--   This replays all migrations from scratch including this one.

-- ── 1. Create expense_payments ────────────────────────────────────────────────

CREATE TABLE "expense_payments" (
    "id"                 UUID        NOT NULL DEFAULT gen_random_uuid(),
    "expense_id"         UUID        NOT NULL,
    "user_id"            UUID        NOT NULL,
    "contribution_minor" INTEGER     NOT NULL,
    "payment_meta"       JSONB,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "expense_payments_pkey" PRIMARY KEY ("id"),
    -- DB-level guard: a payment must be positive. Zero contributions are
    -- semantically invalid — if someone didn't pay, they have no row here.
    CONSTRAINT "expense_payments_contribution_positive_chk"
        CHECK ("contribution_minor" > 0)
);

-- FK: cascade on expense delete (payments have no meaning without their expense)
ALTER TABLE "expense_payments"
    ADD CONSTRAINT "expense_payments_expense_id_fkey"
    FOREIGN KEY ("expense_id") REFERENCES "expenses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: restrict on user delete (preserve accounting history)
ALTER TABLE "expense_payments"
    ADD CONSTRAINT "expense_payments_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unique: one payment row per (expense, payer).
-- Phase 2: one row per expense (single payer).
-- Phase 3+: multiple rows per expense (multi-payer) by lifting this to a
-- check constraint that enforces SUM(contribution_minor) = amount_minor.
CREATE UNIQUE INDEX "expense_payments_expense_id_user_id_key"
    ON "expense_payments"("expense_id", "user_id");

-- Covering indexes for the two dominant access patterns:
--   • fetch all payments for one expense (balance engine, display)
--   • fetch all expenses a user has paid (per-user totals, hasOutstandingBalance)
CREATE INDEX "expense_payments_expense_id_idx" ON "expense_payments"("expense_id");
CREATE INDEX "expense_payments_user_id_idx"   ON "expense_payments"("user_id");

-- ── 2. Backfill from paid_by_id ───────────────────────────────────────────────
-- Each existing expense (active or soft-deleted) gets exactly one payment row.
-- contributionMinor = amountMinor, preserving the full accounting invariant.
-- created_at mirrors the expense's own created_at for temporal consistency.

INSERT INTO "expense_payments"
    ("id", "expense_id", "user_id", "contribution_minor", "created_at", "updated_at")
SELECT
    gen_random_uuid(),
    e."id",
    e."paid_by_id",
    e."amount_minor",
    e."created_at",
    NOW()
FROM "expenses" e
WHERE e."paid_by_id" IS NOT NULL;

-- ── 3. Remove paid_by_id from expenses ───────────────────────────────────────

-- Drop the FK constraint (Prisma's naming convention: table_column_fkey)
ALTER TABLE "expenses"
    DROP CONSTRAINT IF EXISTS "expenses_paid_by_id_fkey";

-- Drop the index (Prisma's naming convention: table_column_idx)
DROP INDEX IF EXISTS "expenses_paid_by_id_idx";

-- Drop the column (cascade not needed — FK is already gone)
ALTER TABLE "expenses"
    DROP COLUMN IF EXISTS "paid_by_id";
