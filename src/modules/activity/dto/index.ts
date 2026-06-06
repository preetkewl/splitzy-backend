/**
 * Wire-format types for the Activity API. Prisma rows never escape the
 * repository/service boundary.
 */
import type { ActivityEntityType, ActivityType } from '@prisma/client';

export interface ActivityDto {
  id: string;
  type: ActivityType;
  /** Who performed the action. The client renders "You" when this == viewer. */
  actorId: string;
  /** Deep-link target. */
  entityType: ActivityEntityType;
  entityId: string | null;
  /** Surrounding trip context. Null for FRIEND_ACCEPTED. */
  tripId: string | null;
  createdAt: string;
  /** Denormalized render snapshot — shape varies by `type`. */
  metadata: Record<string, unknown>;
}

export interface ActivityFeedDto {
  items: ActivityDto[];
  /** Opaque keyset cursor for the next page, or null when none remain. */
  nextCursor: string | null;
}
