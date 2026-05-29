/**
 * Wire-format types for the Settlement API. Prisma rows never escape
 * the repository.
 */
import type { SettlementMethod, SettlementStatus } from '@prisma/client';

export interface UserPreviewDto {
  userId: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
}

/**
 * One persisted money movement. Settlement rows are immutable in the
 * MVP — once created, neither amount nor parties can change. The
 * `status` column is reserved for future PENDING/CANCELLED flows; this
 * step always writes COMPLETED.
 */
export interface SettlementDto {
  id: string;
  tripId: string;
  amountMinor: number;
  status: SettlementStatus;
  method: SettlementMethod;
  note: string | null;
  externalRef: string | null;
  /** When the money actually moved. Always set for COMPLETED rows. */
  settledAt: string | null;
  fromUser: UserPreviewDto;
  toUser: UserPreviewDto;
  createdById: string;
  createdAt: string;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CreateSettlementInput {
  tripId: string;
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
  method?: SettlementMethod;
  note?: string | null;
  externalRef?: string | null;
}
