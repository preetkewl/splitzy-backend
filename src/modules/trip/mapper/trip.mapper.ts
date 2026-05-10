import type {
  TripBalanceSummaryDto,
  TripDetailDto,
  TripMemberDto,
  TripMemberPreviewDto,
  TripSummaryDto,
} from '../dto/index.js';
import type {
  TripDetailRow,
  TripListRow,
  TripMemberWithUser,
} from '../repository/trip.repository.js';

export function toMemberPreview(row: TripMemberWithUser): TripMemberPreviewDto {
  return {
    userId: row.userId,
    name: row.user.name,
    avatarColor: row.user.avatarColor,
    avatarUrl: row.user.avatarUrl,
    role: row.role,
  };
}

export function toMember(row: TripMemberWithUser): TripMemberDto {
  return {
    userId: row.userId,
    name: row.user.name,
    handle: row.user.handle,
    avatarColor: row.user.avatarColor,
    avatarUrl: row.user.avatarUrl,
    upiId: row.user.upiId,
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
  };
}

export function toTripSummary(row: TripListRow, viewerUserId: string): TripSummaryDto {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    coverColor: row.coverColor,
    description: row.description,
    isOwner: row.createdById === viewerUserId,
    memberCount: row.members.length,
    members: row.members.map(toMemberPreview),
    totalAmountPaise: row.totalAmountPaise,
    latestExpenseAt: row.latestExpenseAt === null ? null : row.latestExpenseAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Detail responses include real members + a balance summary placeholder.
 * The Expense module (next step) will swap in non-zero balance numbers.
 */
export function toTripDetail(row: TripDetailRow, viewerUserId: string): TripDetailDto {
  const balanceSummary: TripBalanceSummaryDto = {
    totalAmountPaise: row.totalAmountPaise,
    settledAmountPaise: 0,
    pendingAmountPaise: row.totalAmountPaise,
  };
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    coverColor: row.coverColor,
    description: row.description,
    isOwner: row.createdById === viewerUserId,
    memberCount: row.members.length,
    members: row.members.map(toMember),
    totalAmountPaise: row.totalAmountPaise,
    latestExpenseAt: row.latestExpenseAt === null ? null : row.latestExpenseAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    balanceSummary,
  };
}
