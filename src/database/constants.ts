/**
 * Database-level constants shared by repositories, validators, and seed.
 * Anything that pins a contract between the schema and code lives here.
 */

// ── Pagination ───────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// ── Trip ─────────────────────────────────────────────────────────────────────

/// A trip needs at least the creator + 1 other member to be useful.
export const MIN_TRIP_MEMBERS = 2;

/// Cap to avoid pathological N×M settlement explosions.
export const MAX_TRIP_MEMBERS = 50;

/// Cover-color palette mirrored from `splitzy/lib/data/hive_repository.dart`.
/// Frontend cycles through these on trip creation; backend echoes the same
/// list so created trips look identical to the legacy Hive ones.
export const TRIP_COVER_COLORS = [
  '#EAD9A8', // sand
  '#B8D4E8', // sky
  '#D4E8B8', // mint
  '#E8B8D4', // rose
  '#C8B8E8', // lavender
] as const;

// ── Expense ──────────────────────────────────────────────────────────────────

/// Largest amount we'll accept for a single expense — guards against typos
/// like "1000000000". e.g. in INR: ₹10,00,00,000 (10 crore).
export const MAX_EXPENSE_AMOUNT_MINOR = 100_000_000_000;

/// Largest expense title length (DB column has no hard limit; this is a
/// sanity bound applied at the validation layer).
export const MAX_EXPENSE_TITLE_LENGTH = 120;

// ── Auth ─────────────────────────────────────────────────────────────────────

/// SHA-256 hex digest length. Used by RefreshToken.tokenHash.
export const TOKEN_HASH_LENGTH = 64;

// ── Soft delete ──────────────────────────────────────────────────────────────

/// Spread into a `where` clause to exclude soft-deleted rows.
/// Example: `prisma.user.findMany({ where: { ...notDeleted, ... } })`
export const notDeleted = { deletedAt: null } as const;
