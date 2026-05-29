import type { Settlement, User } from '@prisma/client';
import type { SettlementDto, UserPreviewDto } from '../dto/index.js';

export function toUserPreview(user: User): UserPreviewDto {
  return {
    userId: user.id,
    name: user.name,
    avatarColor: user.avatarColor,
    avatarUrl: user.avatarUrl,
  };
}

export interface SettlementWithUsers extends Settlement {
  fromUser: User;
  toUser: User;
}

export function toSettlementDto(row: SettlementWithUsers): SettlementDto {
  return {
    id: row.id,
    tripId: row.tripId,
    amountMinor: row.amountMinor,
    status: row.status,
    method: row.method,
    note: row.note,
    externalRef: row.externalRef,
    settledAt: row.settledAt?.toISOString() ?? null,
    fromUser: toUserPreview(row.fromUser),
    toUser: toUserPreview(row.toUser),
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
  };
}
