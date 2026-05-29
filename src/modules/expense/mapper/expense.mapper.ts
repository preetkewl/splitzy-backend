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
    shareMinor: p.shareMinor,
    // Audit metadata — null for EQUAL splits, one field populated for others.
    // Old clients that don't recognise these fields receive null and are unaffected.
    basisPoints: p.basisPoints,
    shareUnits: p.shareUnits,
    exactAmountMinor: p.exactAmountMinor,
  };
}

/**
 * Wires `canDelete` based on the requesting user's relationship to the expense.
 *
 * `paidBy` is derived from the first payment row (creation order). The
 * ExpenseDto contract still exposes a single `paidBy` for Phase 2
 * backward-compatibility. Phase 3 will add a `payments[]` field to the DTO
 * and expose full multi-payer data to clients.
 */
export function toExpenseDto(
  row: ExpenseWithRelations,
  ctx: { viewerUserId: string },
): ExpenseDto {
  const canDelete = row.createdById === ctx.viewerUserId;

  const primaryPayment = row.payments[0];
  if (primaryPayment === undefined) {
    throw new Error(
      `toExpenseDto: expense ${row.id} has no payment rows — accounting invariant violated`,
    );
  }

  return {
    id: row.id,
    tripId: row.tripId,
    title: row.title,
    amountMinor: row.amountMinor,
    category: row.category,
    splitType: row.splitType,
    // Derived from the primary payment record (first by createdAt).
    // Phase 2: always the single payer. Phase 3 will surface payments[].
    paidBy: toUserPreview(primaryPayment.user),
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
      netMinor: b.netMinor,
      totalPaidMinor: totals.paid,
      totalShareMinor: totals.share,
      isCurrentMember: ctx.currentMemberIds.has(b.userId),
    };
  });
}

export function toSettlementSuggestion(t: SettlementTransfer): SettlementSuggestionDto {
  return {
    fromUserId: t.fromUserId,
    toUserId: t.toUserId,
    amountMinor: t.amountMinor,
  };
}

export function toBalanceSummary(input: {
  totalAmountMinor: number;
  totalReimbursedMinor: number;
  members: MemberBalanceDto[];
  transfers: readonly SettlementTransfer[];
}): BalanceSummaryDto {
  return {
    totalAmountMinor: input.totalAmountMinor,
    totalReimbursedMinor: input.totalReimbursedMinor,
    members: input.members,
    suggestedTransfers: input.transfers.map(toSettlementSuggestion),
  };
}
