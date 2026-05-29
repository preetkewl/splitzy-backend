-- Terminology migration: rename paise columns to minor-unit-agnostic names.
-- This is a pure rename with ZERO semantic change — existing integer values
-- (stored in INR paise) are unchanged. The new names reflect that the column
-- holds "the smallest indivisible unit of whatever currency applies", which
-- is currency-agnostic and correct for future multi-currency support.

-- Expense table
ALTER TABLE "expenses" RENAME COLUMN "amount_paise" TO "amount_minor";

-- ExpenseParticipant table
ALTER TABLE "expense_participants" RENAME COLUMN "share_paise" TO "share_minor";
ALTER TABLE "expense_participants" RENAME COLUMN "exact_amount_paise" TO "exact_amount_minor";

-- Settlement table
ALTER TABLE "settlements" RENAME COLUMN "amount_paise" TO "amount_minor";
