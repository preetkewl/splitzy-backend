import { logger } from '../../../utils/logger.js';
import type { ActivityFeedDto } from '../dto/index.js';
import { toActivityDto } from '../mapper/activity.mapper.js';
import type {
  ActivityCreateRow,
  ActivityCursor,
  ActivityRepository,
} from '../repository/activity.repository.js';

export const ACTIVITY_DEFAULT_LIMIT = 20;
export const ACTIVITY_MAX_LIMIT = 50;

export interface ActivityFeedQuery {
  limit?: number;
  cursor?: string;
}

/**
 * Owns the V3 activity feed:
 *   - WRITE: fire-and-forget `record*` methods, called beside the existing
 *     push-notification calls in the business services. They NEVER throw —
 *     a failure is logged and swallowed so it can't affect the parent write.
 *   - READ: keyset-paginated `feed()` for the Activity tab.
 *
 * `metadata` is a denormalized render snapshot; its per-type shape is defined
 * once here (the single source of truth) so call sites stay one-liners.
 */
export class ActivityService {
  constructor(private readonly repo: ActivityRepository) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  async feed(userId: string, query: ActivityFeedQuery): Promise<ActivityFeedDto> {
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(query.cursor);

    // Over-fetch by one to detect whether a further page exists.
    const rows = await this.repo.listForUser(userId, limit + 1, cursor);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map(toActivityDto),
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  // ── Writes (fire-and-forget) ────────────────────────────────────────────────

  recordExpenseAdded(input: {
    tripId: string;
    tripName: string;
    actorId: string;
    actorName: string;
    recipientIds: string[];
    expenseId: string;
    title: string;
    amountMinor: number;
  }): void {
    const metadata = {
      actorName: input.actorName,
      tripName: input.tripName,
      title: input.title,
      amountMinor: input.amountMinor,
    };
    this.fanout(input.recipientIds, {
      actorId: input.actorId,
      type: 'EXPENSE_ADDED',
      entityType: 'EXPENSE',
      entityId: input.expenseId,
      tripId: input.tripId,
      metadata,
    });
  }

  recordSettlementCompleted(input: {
    tripId: string;
    tripName: string;
    settlementId: string;
    amountMinor: number;
    actorId: string;
    fromUserId: string;
    fromName: string;
    toUserId: string;
    toName: string;
  }): void {
    // Recipients are the two parties. Metadata carries both names + ids so the
    // client renders the right perspective ("You paid …" / "… paid you").
    const metadata = {
      tripName: input.tripName,
      amountMinor: input.amountMinor,
      fromUserId: input.fromUserId,
      fromName: input.fromName,
      toUserId: input.toUserId,
      toName: input.toName,
    };
    this.fanout([input.fromUserId, input.toUserId], {
      actorId: input.actorId,
      type: 'SETTLEMENT_COMPLETED',
      entityType: 'SETTLEMENT',
      entityId: input.settlementId,
      tripId: input.tripId,
      metadata,
    });
  }

  recordFriendAccepted(input: {
    accepterId: string;
    accepterName: string;
    requesterId: string;
    requesterName: string;
  }): void {
    // Two perspective-specific rows. entityId is the OTHER person (deep-link to
    // their profile / the Friends tab).
    const rows: ActivityCreateRow[] = [
      {
        // Requester's feed: "<accepter> accepted your friend request".
        userId: input.requesterId,
        actorId: input.accepterId,
        type: 'FRIEND_ACCEPTED',
        entityType: 'USER',
        entityId: input.accepterId,
        tripId: null,
        metadata: { actorName: input.accepterName, counterpartyName: input.accepterName },
      },
      {
        // Accepter's own feed: "You and <requester> are now friends".
        userId: input.accepterId,
        actorId: input.accepterId,
        type: 'FRIEND_ACCEPTED',
        entityType: 'USER',
        entityId: input.requesterId,
        tripId: null,
        metadata: { actorName: input.accepterName, counterpartyName: input.requesterName },
      },
    ];
    this.record(rows);
  }

  recordMemberAdded(input: {
    tripId: string;
    tripName: string;
    actorId: string;
    actorName: string;
    recipientIds: string[];
    addedNames: string[];
  }): void {
    const metadata = {
      actorName: input.actorName,
      tripName: input.tripName,
      addedNames: input.addedNames,
    };
    this.fanout(input.recipientIds, {
      actorId: input.actorId,
      type: 'MEMBER_ADDED',
      entityType: 'TRIP',
      entityId: input.tripId,
      tripId: input.tripId,
      metadata,
    });
  }

  recordGroupCreated(input: {
    tripId: string;
    tripName: string;
    actorId: string;
    actorName: string;
    recipientIds: string[];
  }): void {
    const metadata = { actorName: input.actorName, tripName: input.tripName };
    this.fanout(input.recipientIds, {
      actorId: input.actorId,
      type: 'GROUP_CREATED',
      entityType: 'TRIP',
      entityId: input.tripId,
      tripId: input.tripId,
      metadata,
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Expand a shared event into one row per (deduped) recipient. */
  private fanout(recipientIds: string[], shared: Omit<ActivityCreateRow, 'userId'>): void {
    const unique = Array.from(new Set(recipientIds));
    if (unique.length === 0) return;
    this.record(unique.map((userId) => ({ userId, ...shared })));
  }

  /**
   * The single insert path. Fire-and-forget safe: errors are logged and
   * swallowed so `void activity.record*()` can never reject or block the
   * caller's business write.
   */
  private record(rows: ActivityCreateRow[]): void {
    void this.repo
      .createMany(rows)
      .then((count) => {
        logger.debug({ count, type: rows[0]?.type }, 'activity recorded');
      })
      .catch((err: unknown) => {
        logger.error({ err, type: rows[0]?.type }, 'activity record failed (swallowed)');
      });
  }
}

// ── Cursor codec + limit clamp ────────────────────────────────────────────────

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return ACTIVITY_DEFAULT_LIMIT;
  return Math.min(ACTIVITY_MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

/** Opaque cursor = base64url("<createdAtISO>|<id>"). */
function encodeCursor(cursor: ActivityCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): ActivityCursor | null {
  if (raw === undefined || raw === '') return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep === -1) return null;
    const createdAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || id === '') return null;
    return { createdAt, id };
  } catch {
    // Malformed cursor → treat as no cursor (first page) rather than erroring.
    return null;
  }
}
