/**
 * Wire-format types for the Trip API. The mapper translates Prisma rows
 * into these shapes — Prisma entities never escape the repository layer.
 */

import type { TripMemberRole } from '@prisma/client';

// ── Member projections ───────────────────────────────────────────────────────

/**
 * Lightweight projection used in trip-list responses where we only need
 * enough to render the avatar stack.
 */
export interface TripMemberPreviewDto {
  userId: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
  role: TripMemberRole;
}

/**
 * Full member projection used in trip-detail and member-mutation responses.
 * Includes `upiId` because the settle screen needs it.
 */
export interface TripMemberDto {
  userId: string;
  name: string;
  handle: string;
  avatarColor: string;
  avatarUrl: string | null;
  upiId: string | null;
  role: TripMemberRole;
  joinedAt: string;
}

// ── Trip projections ─────────────────────────────────────────────────────────

export interface TripSummaryDto {
  id: string;
  name: string;
  emoji: string;
  coverColor: string;
  description: string | null;
  /** Convenience flag for the requesting user — saves a client-side scan. */
  isOwner: boolean;
  memberCount: number;
  /** All trip members; small lists (<= MAX_TRIP_MEMBERS = 50). */
  members: TripMemberPreviewDto[];
  totalAmountMinor: number;
  latestExpenseAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Placeholder until the Expense module ships. The shape is fixed so the
 * frontend can already render the trip-detail screen against it; the
 * expense module will fill in non-zero values.
 */
export interface TripBalanceSummaryDto {
  totalAmountMinor: number;
  settledAmountMinor: number;
  pendingAmountMinor: number;
}

export interface TripDetailDto {
  id: string;
  name: string;
  emoji: string;
  coverColor: string;
  description: string | null;
  isOwner: boolean;
  memberCount: number;
  members: TripMemberDto[];
  totalAmountMinor: number;
  latestExpenseAt: string | null;
  createdAt: string;
  updatedAt: string;
  balanceSummary: TripBalanceSummaryDto;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CreateTripInput {
  name: string;
  emoji: string;
  coverColor?: string;
  description?: string | null;
  /** UUIDs of users to add as members. The creator is added implicitly. */
  memberIds: string[];
}

export interface UpdateTripInput {
  name?: string;
  emoji?: string;
  coverColor?: string;
  description?: string | null;
}

export interface AddMembersInput {
  userIds: string[];
}
