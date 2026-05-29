/**
 * Wire-format types for the Expense + Balances API.
 *
 * Backward-compatibility notes:
 *   - ExpenseParticipantDto gains three nullable audit fields. Old clients
 *     that ignore unknown JSON keys are unaffected; they receive null for
 *     all three and continue to read shareMinor as the single source of truth.
 *   - ExpenseDto gains splitType (always present) and splitMeta (null for EQUAL,
 *     typed object for EXACT/PERCENT/SHARES). Old clients that don't know these
 *     fields may ignore them safely.
 *   - CreateExpenseInput gains splitType (defaults to EQUAL when absent) and an
 *     optional participants field. Old callers that supply only participantIds
 *     continue to work unchanged.
 *   - Phase 4: ExpenseDto now includes a canonical payments[] array alongside
 *     the deprecated paidBy field. New clients should read payments[]; old clients
 *     continue to read paidBy unchanged.
 *   - Phase 4: CreateExpenseInput accepts an optional payments[] array.
 *     Old clients that supply only paidByUserId continue to work unchanged.
 *
 * SplitMetaDto:
 *   The `splitMeta` field on ExpenseDto is a typed discriminated union instead
 *   of `unknown`. This lets client codegen tools (OpenAPI generators, dart_mappable
 *   for Flutter) produce concrete types rather than dynamic maps.
 *   The shape mirrors what the service persists: { type, participants: { userId → rawValue } }
 *   where rawValue is exactAmountMinor / basisPoints / shareUnits respectively.
 *   EQUAL expenses carry splitMeta: null because the split is fully
 *   reconstructible from amountMinor + participant count.
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
 * participants maps userId → exactAmountMinor (the value the client supplied).
 * This is identical to shareMinor for EXACT splits and is stored for
 * explicitness and future audit queries.
 */
export interface ExactSplitMetaDto {
  type: 'EXACT';
  /**
   * Map of userId → exactAmountMinor as supplied by the client.
   * All values are non-negative integers (minor units).
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
 * amountMinor and participant count, so metadata is intentionally omitted.
 */
export type SplitMetaDto = ExactSplitMetaDto | PercentSplitMetaDto | SharesSplitMetaDto;

// ── Expense ───────────────────────────────────────────────────────────────────

export interface ExpenseParticipantDto extends UserPreviewDto {
  /**
   * Canonical accounting value — the only field the balance engine reads.
   * Present for every split type. Source of truth for all balance math.
   */
  shareMinor: number;
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
  /** EXACT only: client-specified exact minor unit amount. Equals shareMinor for EXACT. */
  exactAmountMinor: number | null;
}

// ── Payment ───────────────────────────────────────────────────────────────────

/**
 * Phase 4 canonical payment entry in the expense response.
 *
 * Represents one contributor and how much they paid toward the expense.
 * Replaces the deprecated single `paidBy` field for multi-payer awareness.
 */
export interface ExpensePaymentDto {
  user: UserPreviewDto;
  /** Amount paid by this user in minor units. Always > 0. */
  contributionMinor: number;
}

export interface ExpenseDto {
  id: string;
  tripId: string;
  title: string;
  amountMinor: number;
  category: ExpenseCategory;
  /**
   * Split strategy used for this expense. Always present.
   * Old clients that pre-date advanced splits always receive 'EQUAL' for
   * historical expenses and should treat unknown values as non-EQUAL display.
   */
  splitType: ExpenseSplitType;
  /**
   * @deprecated Use `payments` instead.
   * Kept for backward compatibility. Derived from payments[0] (first payer by
   * creation order).
   *
   * Phase 5 removal target: once all active client versions read `payments[]`
   * (i.e., min supported build ≥ the Phase 4 Flutter release), delete this field
   * from the DTO, the mapper (expense.mapper.ts toExpenseDto), and the schema.
   * The primaryPayment null-guard in the mapper can be inlined into a
   * `payments.length === 0` invariant check at that point.
   */
  paidBy: UserPreviewDto;
  /**
   * Phase 4 canonical payment list. Always non-empty.
   * Sum of contributionMinor across all entries equals amountMinor.
   * For single-payer expenses, contains exactly one entry.
   */
  payments: ExpensePaymentDto[];
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
  netMinor: number;
  /** SUM of amountMinor from every non-deleted expense this user paid. */
  totalPaidMinor: number;
  /** SUM of shareMinor across every non-deleted expense this user participates in. */
  totalShareMinor: number;
  /** False if the user has since left the trip (historical data preserved). */
  isCurrentMember: boolean;
}

export interface SettlementSuggestionDto {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
}

export interface BalanceSummaryDto {
  totalAmountMinor: number;
  totalReimbursedMinor: number;
  members: MemberBalanceDto[];
  suggestedTransfers: SettlementSuggestionDto[];
}

// ── Input types ───────────────────────────────────────────────────────────────

/**
 * Phase 4 canonical payment input entry.
 * Represents one contributor and how much they are paying toward the expense.
 */
export interface ExpensePaymentInputDto {
  userId: string;
  /** Amount paid by this user in minor units. Must be > 0. */
  contributionMinor: number;
}

export interface CreateExpenseInput {
  tripId: string;
  title: string;
  amountMinor: number;
  /**
   * @deprecated Prefer `payments` for new clients.
   * Backward-compat single-payer ID. When present and `payments` is absent,
   * the service derives a single payment entry covering the full amountMinor.
   * Must be absent or undefined when `payments` is provided.
   *
   * Phase 5 removal target: drop from CreateExpenseInput, Zod baseExpenseFields,
   * service.resolveEffectivePayments() legacy path, and controller toCreateExpenseInput()
   * once all clients on ≥ Phase 4 builds stop sending this field.
   */
  paidByUserId?: string;
  /**
   * Phase 4 canonical payment list. Optional for backward compat.
   * When provided:
   *   - At least one entry required.
   *   - All contributionMinor values must be > 0.
   *   - No duplicate userIds.
   *   - SUM(contributionMinor) must equal amountMinor.
   * When absent, paidByUserId must be provided instead.
   */
  payments?: readonly ExpensePaymentInputDto[];
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
   *   EXACT:   { userId, exactAmountMinor }
   *   PERCENT: { userId, basisPoints }
   *   SHARES:  { userId, shareUnits }
   */
  participants?: readonly RawParticipantInput[];
  category?: ExpenseCategory;
  spentAt: Date;
}
