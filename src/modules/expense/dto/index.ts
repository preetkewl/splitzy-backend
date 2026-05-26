/**
 * Wire-format types for the Expense + Balances API.
 *
 * Backward-compatibility notes:
 *   - ExpenseParticipantDto gains three nullable audit fields. Old clients
 *     that ignore unknown JSON keys are unaffected; they receive null for
 *     all three and continue to read sharePaise as the single source of truth.
 *   - ExpenseDto gains splitType (always present) and splitMeta (null for EQUAL,
 *     typed object for EXACT/PERCENT/SHARES). Old clients that don't know these
 *     fields may ignore them safely.
 *   - CreateExpenseInput gains splitType (defaults to EQUAL when absent) and an
 *     optional participants field. Old callers that supply only participantIds
 *     continue to work unchanged.
 *
 * SplitMetaDto:
 *   The `splitMeta` field on ExpenseDto is a typed discriminated union instead
 *   of `unknown`. This lets client codegen tools (OpenAPI generators, dart_mappable
 *   for Flutter) produce concrete types rather than dynamic maps.
 *   The shape mirrors what the service persists: { type, participants: { userId → rawValue } }
 *   where rawValue is exactAmountPaise / basisPoints / shareUnits respectively.
 *   EQUAL expenses carry splitMeta: null because the split is fully
 *   reconstructible from amountPaise + participant count.
 */
import type { ExpenseCategory, ExpenseSplitType } from '@prisma/client';
import type { RawParticipantInput } from '../engine/split-types.js';

// ── User projections ──────────────────────────────────────────────────────────

export interface UserPreviewDto {
  userId: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
}

// ── Split metadata audit snapshot ─────────────────────────────────────────────

/**
 * EXACT audit snapshot stored on the expense row.
 * participants maps userId → exactAmountPaise (the value the client supplied).
 * This is identical to sharePaise for EXACT splits and is stored for
 * explicitness and future audit queries.
 */
export interface ExactSplitMetaDto {
  type: 'EXACT';
  /**
   * Map of userId → exactAmountPaise as supplied by the client.
   * All values are non-negative integers (paise).
   */
  participants: Record<string, number>;
}

/**
 * PERCENT audit snapshot stored on the expense row.
 * participants maps userId → basisPoints (1–10 000).
 * 10 000 bp = 100%. SUM(values) === 10 000.
 */
export interface PercentSplitMetaDto {
  type: 'PERCENT';
  /**
   * Map of userId → basisPoints as supplied by the client.
   * All values are integers in [1, 10000]. Sum equals 10000.
   */
  participants: Record<string, number>;
}

/**
 * SHARES audit snapshot stored on the expense row.
 * participants maps userId → shareUnits (1–1 000 000).
 * Shares are proportional; there is no sum constraint.
 */
export interface SharesSplitMetaDto {
  type: 'SHARES';
  /**
   * Map of userId → shareUnits as supplied by the client.
   * All values are positive integers in [1, 1000000].
   */
  participants: Record<string, number>;
}

/**
 * Typed discriminated union over all non-EQUAL split audit snapshots.
 *
 * Null for EQUAL expenses — the split is fully reconstructible from
 * amountPaise and participant count, so metadata is intentionally omitted.
 */
export type SplitMetaDto = ExactSplitMetaDto | PercentSplitMetaDto | SharesSplitMetaDto;

// ── Expense ───────────────────────────────────────────────────────────────────

export interface ExpenseParticipantDto extends UserPreviewDto {
  /**
   * Canonical accounting value — the only field the balance engine reads.
   * Present for every split type. Source of truth for all balance math.
   */
  sharePaise: number;
  /**
   * Audit metadata fields — at most one is non-null per participant.
   * Null for EQUAL splits (split is reconstructible; audit data is noise).
   * Old clients that do not expect these fields receive null and are unaffected.
   *
   * PERCENT only: participant's share in basis points (1–10 000; 10 000 = 100%).
   */
  basisPoints: number | null;
  /** SHARES only: raw ratio unit count (1–1 000 000). */
  shareUnits: number | null;
  /** EXACT only: client-specified exact paise amount. Equals sharePaise for EXACT. */
  exactAmountPaise: number | null;
}

export interface ExpenseDto {
  id: string;
  tripId: string;
  title: string;
  amountPaise: number;
  category: ExpenseCategory;
  /**
   * Split strategy used for this expense. Always present.
   * Old clients that pre-date advanced splits always receive 'EQUAL' for
   * historical expenses and should treat unknown values as non-EQUAL display.
   */
  splitType: ExpenseSplitType;
  paidBy: UserPreviewDto;
  participants: ExpenseParticipantDto[];
  /**
   * Immutable audit snapshot of the raw split intent supplied by the client.
   *
   * null  — EQUAL split (split is reconstructible; no snapshot needed).
   * typed — EXACT / PERCENT / SHARES: stores the original per-participant values
   *         so clients can display "Anjali: 40%" rather than "Anjali: ₹480.00".
   *
   * The balance engine never reads this field. It is display/audit data only.
   * Old clients may treat it as an opaque nullable object.
   */
  splitMeta: SplitMetaDto | null;
  spentAt: string;
  createdAt: string;
  updatedAt: string;
  /** True if the requester may delete this expense (only the creator may). */
  canDelete: boolean;
}

// ── Balances ──────────────────────────────────────────────────────────────────

export interface MemberBalanceDto extends UserPreviewDto {
  /** > 0: owed to this user; < 0: this user owes others; 0: settled. */
  netPaise: number;
  /** SUM of amountPaise from every non-deleted expense this user paid. */
  totalPaidPaise: number;
  /** SUM of sharePaise across every non-deleted expense this user participates in. */
  totalSharePaise: number;
  /** False if the user has since left the trip (historical data preserved). */
  isCurrentMember: boolean;
}

export interface SettlementSuggestionDto {
  fromUserId: string;
  toUserId: string;
  amountPaise: number;
}

export interface BalanceSummaryDto {
  totalAmountPaise: number;
  totalReimbursedPaise: number;
  members: MemberBalanceDto[];
  suggestedTransfers: SettlementSuggestionDto[];
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface CreateExpenseInput {
  tripId: string;
  title: string;
  amountPaise: number;
  paidByUserId: string;
  /**
   * Defaults to EQUAL for backward compatibility with old clients that
   * do not send this field. Non-EQUAL types are gated by the
   * FEATURE_SPLIT_TYPES_ENABLED flag in the service layer.
   */
  splitType: ExpenseSplitType;
  /**
   * EQUAL only. Optional — if absent or empty, all current trip members
   * participate. Ignored when splitType !== EQUAL.
   */
  participantIds?: readonly string[];
  /**
   * EXACT / PERCENT / SHARES only. Required when splitType !== EQUAL.
   * Contains the per-participant split values in the format appropriate
   * for the split type:
   *   EXACT:   { userId, exactAmountPaise }
   *   PERCENT: { userId, basisPoints }
   *   SHARES:  { userId, shareUnits }
   */
  participants?: readonly RawParticipantInput[];
  category?: ExpenseCategory;
  spentAt: Date;
}
