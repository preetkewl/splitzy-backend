/**
 * Wire-format types for the Expense + Balances API.
 */
import type { ExpenseCategory, ExpenseSplitType } from '@prisma/client';

// ── User projections ─────────────────────────────────────────────────────────

export interface UserPreviewDto {
  userId: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
}

// ── Expense ──────────────────────────────────────────────────────────────────

export interface ExpenseParticipantDto extends UserPreviewDto {
  sharePaise: number;
}

export interface ExpenseDto {
  id: string;
  tripId: string;
  title: string;
  amountPaise: number;
  category: ExpenseCategory;
  splitType: ExpenseSplitType;
  paidBy: UserPreviewDto;
  participants: ExpenseParticipantDto[];
  spentAt: string;
  createdAt: string;
  updatedAt: string;
  /** True if the requester may delete this expense (payer or trip owner). */
  canDelete: boolean;
}

// ── Balances ─────────────────────────────────────────────────────────────────

export interface MemberBalanceDto extends UserPreviewDto {
  /** > 0: this user is owed; < 0: this user owes; 0: settled. */
  netPaise: number;
  /** SUM of `amountPaise` from every expense this user paid for. */
  totalPaidPaise: number;
  /** SUM of `sharePaise` across every expense this user is a participant in. */
  totalSharePaise: number;
  /** Whether this user is currently a member of the trip. */
  isCurrentMember: boolean;
}

export interface SettlementSuggestionDto {
  fromUserId: string;
  toUserId: string;
  amountPaise: number;
}

export interface BalanceSummaryDto {
  /** SUM of every (non-deleted) expense in the trip. */
  totalAmountPaise: number;
  /** SUM of every COMPLETED settlement in the trip. (Always 0 until Step 5.) */
  totalReimbursedPaise: number;
  members: MemberBalanceDto[];
  suggestedTransfers: SettlementSuggestionDto[];
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CreateExpenseInput {
  tripId: string;
  title: string;
  amountPaise: number;
  paidByUserId: string;
  /**
   * Optional. If absent, every current trip member is a participant
   * (the MVP frontend doesn't ask the user to pick — split is implicit).
   * If provided, the payer must be in the list.
   */
  participantIds?: readonly string[];
  category?: ExpenseCategory;
  spentAt: Date;
}
