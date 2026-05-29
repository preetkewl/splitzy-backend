-- ============================================================================
-- Migration: add_split_metadata_fields
-- ============================================================================
--
-- PURPOSE
--   Add two groups of nullable columns that support the new split types
--   introduced by migration 20260526100000_add_split_type_enum_values:
--
--   GROUP A — expenses.splitMeta (JSONB, nullable)
--     An immutable audit snapshot of the raw split intent as supplied by the
--     client at creation time. This column is NEVER read by the balance
--     engine. sharePaise on expense_participants remains the sole source of
--     truth for all balance calculations. splitMeta exists so that the
--     original user-supplied percentages / share-unit ratios / exact amounts
--     can be displayed or audited without reverse-engineering them from the
--     computed sharePaise values.
--
--   GROUP B — expense_participants metadata columns (INTEGER, all nullable)
--     Per-participant metadata that mirrors the per-row portion of the split
--     intent. Like splitMeta, these are supplementary display / audit fields.
--     The balance engine reads only sharePaise.
--
--       basisPoints      — PERCENT split only. Participant's share expressed
--                          in basis points (1/100 of a percent). The sum of
--                          basisPoints across all participants for a PERCENT
--                          expense must equal 10 000 (enforced by the service
--                          layer; no cross-row CHECK is expressible in SQL).
--                          Valid range: 1–10 000.
--
--       shareUnits       — SHARES split only. The raw ratio unit for this
--                          participant (e.g., if the split is 3:5:7, this
--                          column holds 3, 5, or 7 respectively). The actual
--                          sharePaise is floor(shareUnits / totalShareUnits *
--                          amountPaise), with the remainder absorbed by the
--                          largest-remainder-method participant.
--                          Valid range: 1–1 000 000.
--
--       exactAmountPaise — EXACT split only. The client-specified exact
--                          amount this participant owes, in paise. Stored for
--                          audit; sharePaise equals this value for EXACT splits
--                          (no rounding is involved when amounts are user-
--                          supplied). The sum of exactAmountPaise across all
--                          participants must equal expenses.amountPaise.
--                          Valid range: 0–MAX_EXPENSE_AMOUNT_PAISE.
--
-- BACKWARD COMPATIBILITY
--   All new columns are nullable with no defaults. Every existing row in
--   expenses and expense_participants keeps NULL in these columns, which is
--   the correct state for historical EQUAL expenses:
--     • EQUAL splits have no meaningful metadata beyond amountPaise and n.
--     • The balance engine continues to read only sharePaise — untouched.
--     • The Prisma client generated from the updated schema treats all new
--       fields as T | null, so existing repository code compiles without
--       modification.
--
-- SAFETY
--   ADD COLUMN on a nullable column with no default is a metadata-only
--   operation in PostgreSQL 11+. It does not rewrite the table and acquires
--   only a brief AccessExclusiveLock for the catalog update. No downtime is
--   required, even on large tables.
--
-- CHECK CONSTRAINTS
--   Two per-row constraints are added on expense_participants:
--
--   1. expense_participants_single_meta_chk
--      At most one metadata column may be non-NULL for a given row.
--      A PERCENT participant has basisPoints; a SHARES participant has
--      shareUnits; an EXACT participant has exactAmountPaise; an EQUAL
--      participant has all three NULL. Having two non-NULL values
--      simultaneously indicates a logic error in the write path and must
--      be rejected at the database level.
--
--   2. expense_participants_meta_range_chk
--      Guards the valid range of each metadata column when set:
--        basisPoints      ∈ [1, 10 000]
--        shareUnits       ∈ [1, 1 000 000]
--        exactAmountPaise ≥ 0
--
--   Prisma does not model CHECK constraints in its schema DSL, so these
--   constraints live only in the migration SQL and the database. They will
--   not appear in schema.prisma but will remain active in the database and
--   will enforce correctness independently of the application layer.
--
-- ROLLBACK
--   This migration is fully reversible (unlike enum migrations). If a
--   rollback is needed before the feature flag is enabled:
--
--     ALTER TABLE "expense_participants"
--       DROP CONSTRAINT "expense_participants_single_meta_chk",
--       DROP CONSTRAINT "expense_participants_meta_range_chk",
--       DROP COLUMN "basisPoints",
--       DROP COLUMN "shareUnits",
--       DROP COLUMN "exactAmountPaise";
--
--     ALTER TABLE "expenses" DROP COLUMN "splitMeta";
--
--   Do NOT attempt to roll back the companion enum migration — enum value
--   removal is not supported in PostgreSQL.
-- ============================================================================


-- ── Group A: expenses ─────────────────────────────────────────────────────────

ALTER TABLE "expenses"
  ADD COLUMN "splitMeta" JSONB;

-- No index on splitMeta at this stage. A GIN index (for JSON key-lookups)
-- is only warranted if a future query pattern searches or filters on splitMeta
-- contents. Add it in a separate, later migration once query patterns are known.


-- ── Group B: expense_participants ─────────────────────────────────────────────

ALTER TABLE "expense_participants"
  ADD COLUMN "basis_points"       INTEGER,
  ADD COLUMN "share_units"        INTEGER,
  ADD COLUMN "exact_amount_paise" INTEGER;


-- ── Check constraints on expense_participants ─────────────────────────────────

-- Constraint 1: at most one metadata column may be populated per row.
ALTER TABLE "expense_participants"
  ADD CONSTRAINT "expense_participants_single_meta_chk" CHECK (
    (
      CASE WHEN "basis_points"       IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN "share_units"        IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN "exact_amount_paise" IS NOT NULL THEN 1 ELSE 0 END
    ) <= 1
  );

-- Constraint 2: each metadata column's value must be within its valid range
-- when populated. NULL columns pass this constraint vacuously.
ALTER TABLE "expense_participants"
  ADD CONSTRAINT "expense_participants_meta_range_chk" CHECK (
    (  "basis_points"       IS NULL OR ("basis_points"       >= 1 AND "basis_points"       <= 10000))
    AND ("share_units"        IS NULL OR ("share_units"        >= 1 AND "share_units"        <= 1000000))
    AND ("exact_amount_paise" IS NULL OR  "exact_amount_paise" >= 0)
  );
