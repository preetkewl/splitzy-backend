import type { Activity } from '@prisma/client';
import type { ActivityDto } from '../dto/index.js';

export function toActivityDto(row: Activity): ActivityDto {
  return {
    id: row.id,
    type: row.type,
    actorId: row.actorId,
    entityType: row.entityType,
    entityId: row.entityId,
    tripId: row.tripId,
    createdAt: row.createdAt.toISOString(),
    // Prisma types JSON as `JsonValue`; the column is always written as an
    // object by the activity service, so this cast is safe for the wire DTO.
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
  };
}
