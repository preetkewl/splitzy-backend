import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants.js';

// ── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationInput {
  page?: number;
  pageSize?: number;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/**
 * Normalize raw pagination input into a clamped `{ skip, take }` pair safe
 * to pass directly to Prisma. Validation (positive integers, etc.) should
 * happen in the request validator; this is the last-line clamp.
 */
export function paginate(input: PaginationInput | undefined): PaginationParams {
  const page = Math.max(1, Math.floor(input?.page ?? 1));
  const requested = Math.floor(input?.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requested));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

// ── Friendship canonical pair ────────────────────────────────────────────────

/**
 * Friendship rows are stored once with the lexicographically smaller UUID
 * in `userAId`. Use this helper anywhere we read or write a Friendship.
 *
 * Postgres UUIDs string-compare in the same order they sort as `uuid` —
 * either comparison is consistent.
 */
export function canonicalFriendshipPair(
  user1: string,
  user2: string,
): { userAId: string; userBId: string } {
  if (user1 === user2) {
    throw new Error('Friendship requires two distinct users');
  }
  return user1 < user2
    ? { userAId: user1, userBId: user2 }
    : { userAId: user2, userBId: user1 };
}

// ── Equal-split share computation ────────────────────────────────────────────
//
// Removed in Step 8: the canonical implementation now lives in
//   src/modules/expense/engine/balance-engine.ts → BalanceEngine.splitEqual
// Domain math belongs in the engine; `database/helpers.ts` should stay
// limited to data-layer primitives (pagination, canonical pairs).
// The Goa seed and the verify-shares regression test both import from
// the engine directly.
