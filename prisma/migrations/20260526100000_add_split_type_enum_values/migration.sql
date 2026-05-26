-- ============================================================================
-- Migration: add_split_type_enum_values
-- ============================================================================
--
-- PURPOSE
--   Extend the ExpenseSplitType enum with the three new split strategies.
--   EQUAL remains the default and is not affected in any way.
--
-- ISOLATION RATIONALE
--   In PostgreSQL, ALTER TYPE … ADD VALUE executes outside the transaction
--   block that Prisma wraps around each migration. If this file contained
--   additional DDL (ALTER TABLE, CREATE INDEX, etc.) and the process died
--   mid-migration, the enum values would exist permanently with no rollback
--   path while the table changes would be absent. Keeping this file to enum
--   DDL only means the worst-case outcome is three dormant enum values —
--   harmless, because no code uses them until migration 20260526100001
--   runs and new service logic is wired in.
--
-- BACKWARD COMPATIBILITY
--   • Every existing "expenses" row has splitType = 'EQUAL'. No rows are
--     touched by this migration.
--   • Old application code that only ever writes EQUAL continues to work
--     without modification.
--   • The new values sit dormant until the service layer (a future PR)
--     explicitly selects them.
--
-- ROLLBACK NOTE
--   ALTER TYPE … ADD VALUE cannot be rolled back in PostgreSQL. Confirm this
--   migration has been applied to a production-clone environment and verified
--   before running against production.
-- ============================================================================

ALTER TYPE "ExpenseSplitType" ADD VALUE 'EXACT';
ALTER TYPE "ExpenseSplitType" ADD VALUE 'PERCENT';
ALTER TYPE "ExpenseSplitType" ADD VALUE 'SHARES';
