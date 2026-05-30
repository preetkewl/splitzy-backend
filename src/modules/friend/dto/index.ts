/**
 * Wire-format types for the Friends API. Prisma rows never escape the
 * repository; the mapper produces these shapes.
 */
import type { FriendRequestStatus } from '@prisma/client';

// ── User projection used everywhere ──────────────────────────────────────────

export interface FriendUserPreviewDto {
  userId: string;
  name: string;
  handle: string;
  avatarColor: string;
  avatarUrl: string | null;
}

// ── Friends list ─────────────────────────────────────────────────────────────

export interface FriendDto extends FriendUserPreviewDto {
  /** When the friendship became canonical (first acceptance). */
  since: string;
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Relationship between the searcher and a result, surfaced so the
 * frontend can render the right call-to-action without a second
 * round-trip ("+ Add", "Pending", "Friends").
 */
export type FriendSearchRelationship =
  | 'none'
  | 'friend'
  | 'request_outgoing'
  | 'request_incoming';

export interface FriendSearchResultDto extends FriendUserPreviewDto {
  /** Soft hint, sometimes useful for invite-by-phone fallback. Null for Google-only users. */
  phone: string | null;
  relationship: FriendSearchRelationship;
  /**
   * If `relationship` is `request_outgoing` or `request_incoming`, the
   * id of that request — saves the frontend an extra GET to act on it.
   */
  requestId: string | null;
}

// ── Requests ─────────────────────────────────────────────────────────────────

/**
 * Direction is from the *requesting user's* perspective:
 *   - `incoming`: someone sent the request to me; I accept/reject
 *   - `outgoing`: I sent the request; the counterparty acts on it
 */
export type FriendRequestDirection = 'incoming' | 'outgoing';

export interface FriendRequestDto {
  id: string;
  direction: FriendRequestDirection;
  status: FriendRequestStatus;
  /** The *other* user — for incoming this is the sender; for outgoing the receiver. */
  counterparty: FriendUserPreviewDto;
  /** Free-text note from the sender, if any. */
  message: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export interface FriendRequestListDto {
  incoming: FriendRequestDto[];
  outgoing: FriendRequestDto[];
}

// ── Contacts sync ─────────────────────────────────────────────────────────────

/**
 * One matched user returned by POST /friends/contacts/sync. Structurally
 * identical to a search result — same shape, same relationship enum,
 * same requestId hint — so we alias it rather than duplicate the type.
 */
export type ContactMatchDto = FriendSearchResultDto;

export interface ContactSyncResultDto {
  matches: ContactMatchDto[];
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface SendFriendRequestInput {
  targetUserId: string;
  message?: string | null;
}
