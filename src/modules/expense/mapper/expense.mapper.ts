import type { User } from '@prisma/client';
import type {
  BalanceSummaryDto,
  ExpenseDto,
  ExpenseParticipantDto,
  MemberBalanceDto,
  SettlementSuggestionDto,
  SplitMetaDto,
  UserPreviewDto,
} from '../dto/index.js';
import type {
  NetBalance,
  SettlementTransfer,
} from '../engine/balance-engine.js';
import type {
  ExpenseParticipantWithUser,
  ExpenseWithRelations,
} from '../repository/expense.repository.js';

export function toUserPreview(user: User): UserPreviewDto {
  return {
    userId: user.id,
    name: user.name,
    avatarColor: user.avatarColor,
    avatarUrl: user.avatarUrl,
  };
}

export function toExpenseParticipant(p: ExpenseParticipantWithUser): ExpenseParticipantDto {
  return {
    ...toUserPreview(p.user),
    // Canonical accounting value — always present.
    sharePaise: p.sharePaise,
    // Audit metadata — null for EQUAL splits, one field populated for others.
    // Old clients that don't recognise these fields receive null and are unaffected.
    basisPoints: p.basisPoints,
    shareUnits: p.shareUnits,
    exactAmountPaise: p.exactAmountPaise,
  };
}

/** Wires `canDelete` based on the requesting user's relationship to the expense. */
export function toExpenseDto(
  row: ExpenseWithRelations,
  ctx: { viewerUserId: string },
): ExpenseDto {
  const canDelete = row.createdById === ctx.viewerUserId;
  return {
    id: row.id,
    tripId: row.tripId,
    title: row.title,
    amountPaise: row.amountPaise,
    category: row.category,
    splitType: row.splitType,
    paidBy: toUserPreview(row.paidBy),
    participants: row.participants.map(toExpenseParticipant),
    // Audit snapshot — null for EQUAL expenses, structured JSON for others.
    // Prisma returns the JSONB column as `JsonValue` (object | null). We cast
    // to the typed SplitMetaDto union. The cast is safe because the service's
    // buildSplitMeta() always produces exactly this shape: { type, participants }.
    // Old EQUAL expenses have this column as NULL in the DB, which Prisma
    // deserialises as null — correct for SplitMetaDto | null.
    splitMeta: row.splitMeta as SplitMetaDto | null,
    spentAt: row.spentAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canDelete,
  };
}

// ── Balance mappers ──────────────────────────────────────────────────────────

export interface MemberBalanceContext {
  netBalances: readonly NetBalance[];
  totalsByUser: ReadonlyMap<string, { paid: number; share: number }>;
  userById: ReadonlyMap<string, User>;
  currentMemberIds: ReadonlySet<string>;
}

export function toMemberBalances(ctx: MemberBalanceContext): MemberBalanceDto[] {
  return ctx.netBalances.map((b) => {
    const u = ctx.userById.get(b.userId);
    const totals = ctx.totalsByUser.get(b.userId) ?? { paid: 0, share: 0 };
    return {
      userId: b.userId,
      name: u?.name ?? '(unknown)',
      avatarColor: u?.avatarColor ?? '#999999',
      avatarUrl: u?.avatarUrl ?? null,
      netPaise: b.netPaise,
      totalPaidPaise: totals.paid,
      totalSharePaise: totals.share,
      isCurrentMember: ctx.currentMemberIds.has(b.userId),
    };
  });
}

export function toSettlementSuggestion(t: SettlementTransfer): SettlementSuggestionDto {
  return {
    fromUserId: t.fromUserId,
    toUserId: t.toUserId,
    amountPaise: t.amountPaise,
  };
}

export function toBalanceSummary(input: {
  totalAmountPaise: number;
  totalReimbursedPaise: number;
  members: MemberBalanceDto[];
  transfers: readonly SettlementTransfer[];
}): BalanceSummaryDto {
  return {
    totalAmountPaise: input.totalAmountPaise,
    totalReimbursedPaise: input.totalReimbursedPaise,
    members: input.members,
    suggestedTransfers: input.transfers.map(toSettlementSuggestion),
  };
}
