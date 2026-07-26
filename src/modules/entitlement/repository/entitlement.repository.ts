import type {
  AuditEventType,
  AuditSource,
  EntitlementChangeReason,
  EntitlementHistory,
  EntitlementSource,
  Prisma,
  PrismaClient,
  SubscriptionPurchase,
  UserEntitlement,
} from '@prisma/client';
// Used as runtime values (defaults / query filters), so a value import.
import { EntitlementStatus, EntitlementType, SubscriptionState } from '@prisma/client';
import { REWARD_TYPES } from '../constants.js';

/**
 * Any Prisma executor — the base client or an interactive-transaction client.
 * Repository methods accept one so a service can run several writes atomically
 * inside `prisma.$transaction(tx => …)` while still reusing the same data
 * access code outside a transaction.
 */
export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Thrown when a write would bind or mutate a purchase token that already belongs
 * to a DIFFERENT account. A domain-level error (no HTTP coupling) so the service
 * maps it to a 409; it exists so `upsertVerifiedPurchase` can NEVER silently
 * re-own another user's purchase, even if a caller forgets the ownership guard.
 */
export class PurchaseOwnershipError extends Error {
  constructor(
    public readonly purchaseToken: string,
    public readonly ownerUserId: string,
    public readonly requesterUserId: string,
  ) {
    super('Purchase token is owned by a different account');
    this.name = 'PurchaseOwnershipError';
  }
}

export interface RecordPurchaseInput {
  userId: string;
  purchaseToken: string;
  productId: string;
  /** Initial billing state. Foundation always records PENDING (unverified). */
  state?: SubscriptionState;
}

/** Verified purchase fields, sourced authoritatively from Google. */
export interface VerifiedPurchaseInput {
  userId: string;
  purchaseToken: string;
  productId: string;
  state: SubscriptionState;
  orderId: string | null;
  purchasedAt: Date | null;
  expiresAt: Date | null;
  autoRenewing: boolean;
  acknowledged: boolean;
  linkedPurchaseToken: string | null;
  latestGoogleState: Prisma.InputJsonValue;
}

export interface UpsertEntitlementInput {
  userId: string;
  entitlement: EntitlementType;
  source: EntitlementSource;
  sourceRef: string | null;
  status: EntitlementStatus;
  startsAt?: Date;
  expiresAt: Date | null;
}

export interface AuditLogInput {
  eventType: AuditEventType;
  source: AuditSource;
  userId?: string | null;
  purchaseToken?: string | null;
  payload?: Prisma.InputJsonValue;
  googleMessageId?: string | null;
  processedOk?: boolean;
}

export interface HistoryInput {
  userId: string;
  entitlement: EntitlementType;
  fromStatus: EntitlementStatus | null;
  toStatus: EntitlementStatus;
  reason: EntitlementChangeReason;
  relatedPurchaseId?: string | null;
  effectiveAt?: Date;
}

/**
 * Thin Prisma data-access layer for the entitlement foundation. Holds no
 * business rules — derivation, idempotency orchestration, and transactions live
 * in the services. Every mutating method takes an optional `db` executor so it
 * can participate in a service-owned transaction.
 */
export class EntitlementRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ── Purchase ledger ────────────────────────────────────────────────────────

  findPurchaseByToken(purchaseToken: string, db: Db = this.prisma): Promise<SubscriptionPurchase | null> {
    return db.subscriptionPurchase.findUnique({ where: { purchaseToken } });
  }

  /**
   * Serializes all writers for a given purchase token by taking a transaction-
   * scoped Postgres advisory lock keyed on the token. MUST be called with a
   * transaction executor as the FIRST statement in the verify transaction: it
   * makes the "check ownership → upsert → grant" sequence atomic against
   * concurrent verifies of the SAME token, including brand-new tokens that have
   * no row yet to `SELECT ... FOR UPDATE`. The lock releases automatically when
   * the transaction commits or rolls back. Mirrors the advisory-lock convention
   * already used by the reward / limit-evaluation services.
   */
  async acquireTokenLock(purchaseToken: string, db: Db = this.prisma): Promise<void> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${purchaseToken}))`;
  }

  /**
   * Row-locks the existing purchase for a token (`SELECT ... FOR UPDATE`) and
   * returns its owner, or null when no row exists yet. Used inside the verify
   * transaction (after {@link acquireTokenLock}) so the ownership decision reads
   * committed, locked state.
   */
  async lockPurchaseOwner(purchaseToken: string, db: Db = this.prisma): Promise<{ id: string; userId: string } | null> {
    const rows = await db.$queryRaw<Array<{ id: string; userId: string }>>`
      SELECT "id", "userId" FROM "subscription_purchases" WHERE "purchaseToken" = ${purchaseToken} FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  /**
   * Idempotent on `purchaseToken` (its unique constraint). A repeat call for the
   * same token UPDATES the existing row rather than inserting a duplicate — the
   * replay-safe write. Cross-user ownership is enforced one level up, in the
   * service, before this is reached.
   */
  upsertPurchase(input: RecordPurchaseInput, db: Db = this.prisma): Promise<SubscriptionPurchase> {
    const state = input.state ?? SubscriptionState.PENDING;
    return db.subscriptionPurchase.upsert({
      where: { purchaseToken: input.purchaseToken },
      create: {
        userId: input.userId,
        purchaseToken: input.purchaseToken,
        productId: input.productId,
        state,
      },
      // Foundation never downgrades verified state; it only re-touches the row.
      // (Verification/RTDN phases will pass richer update data through a
      // dedicated method.) Keep the update minimal and non-destructive.
      update: { productId: input.productId },
    });
  }

  /**
   * Idempotent on `purchaseToken`: persist the Google-verified state. On a
   * repeat verify by the SAME owner this UPDATES the existing row in place (no
   * duplicate).
   *
   * OWNERSHIP-SAFE: it can NEVER re-bind or update a token owned by another
   * account. Implemented as find→guard→update/create (not a blind `upsert`,
   * whose UPDATE branch omits userId and would therefore silently mutate another
   * user's row): if the existing row belongs to a different user it throws
   * {@link PurchaseOwnershipError}. This is the last line of defence behind the
   * service's advisory lock + ownership check; the `purchaseToken` unique
   * constraint remains the final backstop for a truly concurrent insert.
   */
  async upsertVerifiedPurchase(input: VerifiedPurchaseInput, db: Db = this.prisma): Promise<SubscriptionPurchase> {
    const shared = {
      productId: input.productId,
      state: input.state,
      orderId: input.orderId,
      purchasedAt: input.purchasedAt,
      expiresAt: input.expiresAt,
      autoRenewing: input.autoRenewing,
      acknowledged: input.acknowledged,
      linkedPurchaseToken: input.linkedPurchaseToken,
      latestGoogleState: input.latestGoogleState,
    };

    const existing = await db.subscriptionPurchase.findUnique({
      where: { purchaseToken: input.purchaseToken },
      select: { id: true, userId: true },
    });

    if (existing) {
      if (existing.userId !== input.userId) {
        throw new PurchaseOwnershipError(input.purchaseToken, existing.userId, input.userId);
      }
      // Update by id and never touch userId — ownership is immutable here.
      return db.subscriptionPurchase.update({ where: { id: existing.id }, data: shared });
    }

    return db.subscriptionPurchase.create({
      data: { userId: input.userId, purchaseToken: input.purchaseToken, ...shared },
    });
  }

  /** Persist that a purchase has been acknowledged to Google. */
  setAcknowledged(purchaseId: string, db: Db = this.prisma): Promise<unknown> {
    return db.subscriptionPurchase.update({
      where: { id: purchaseId },
      data: { acknowledged: true },
    });
  }

  /**
   * Set the billing state without touching the Google snapshot. Used by the
   * force-revoke (voided purchase) and force-expire paths, which do not depend
   * on a successful subscriptionsv2.get.
   */
  setPurchaseState(purchaseId: string, state: SubscriptionState, db: Db = this.prisma): Promise<unknown> {
    return db.subscriptionPurchase.update({ where: { id: purchaseId }, data: { state } });
  }

  /**
   * Acknowledgment-sweep source: entitling-state purchases not yet acknowledged.
   * Bounded by `limit`; the 3-day Google auto-refund window makes this the
   * safety net when a post-verify ack failed.
   */
  listUnacknowledgedPurchases(limit: number, db: Db = this.prisma): Promise<SubscriptionPurchase[]> {
    return db.subscriptionPurchase.findMany({
      where: {
        acknowledged: false,
        state: { in: [SubscriptionState.ACTIVE, SubscriptionState.CANCELED, SubscriptionState.IN_GRACE_PERIOD] },
      },
      orderBy: [{ createdAt: 'asc' }],
      take: limit,
    });
  }

  /** Ack-backlog gauge: entitling purchases still unacknowledged (3-day refund risk). */
  countUnacknowledged(db: Db = this.prisma): Promise<number> {
    return db.subscriptionPurchase.count({
      where: {
        acknowledged: false,
        state: { in: [SubscriptionState.ACTIVE, SubscriptionState.CANCELED, SubscriptionState.IN_GRACE_PERIOD] },
      },
    });
  }

  /**
   * Reconciliation-sweep source: non-terminal purchases worth re-checking
   * against Google (recovers from missed RTDN / drift). Oldest-touched first so
   * a bounded run makes steady progress. EXPIRED/REVOKED are terminal and skipped.
   */
  listReconcilablePurchases(limit: number, db: Db = this.prisma): Promise<SubscriptionPurchase[]> {
    return db.subscriptionPurchase.findMany({
      where: { state: { notIn: [SubscriptionState.EXPIRED, SubscriptionState.REVOKED] } },
      orderBy: [{ updatedAt: 'asc' }],
      take: limit,
    });
  }

  // ── Entitlements ─────────────────────────────────────────────────────────────

  /**
   * The hot read: a single ACTIVE, non-expired entitlement row of a given type.
   * Served by the (userId, entitlement, status) index. Returns the row with the
   * furthest-out expiry so a perpetual (NULL expiresAt) grant wins.
   */
  findActiveEntitlement(
    userId: string,
    entitlement: EntitlementType,
    now: Date = new Date(),
    db: Db = this.prisma,
  ): Promise<UserEntitlement | null> {
    return db.userEntitlement.findFirst({
      where: {
        userId,
        entitlement,
        status: EntitlementStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ expiresAt: 'desc' }],
    });
  }

  /**
   * The ACTIVE entitlement granted by a SPECIFIC source record (a given
   * purchase). Unlike {@link findActiveEntitlement}, this targets one link of a
   * subscription chain by its `sourceRef` — so closing a superseded/expired
   * predecessor can never touch the successor's entitlement, and vice-versa.
   * Status filter is ACTIVE only (no expiry filter: an event may legitimately
   * close an already-past-expiry-but-still-ACTIVE row, e.g. within grace).
   */
  findActiveEntitlementBySource(
    userId: string,
    entitlement: EntitlementType,
    source: EntitlementSource,
    sourceRef: string,
    db: Db = this.prisma,
  ): Promise<UserEntitlement | null> {
    return db.userEntitlement.findFirst({
      where: { userId, entitlement, source, sourceRef, status: EntitlementStatus.ACTIVE },
    });
  }

  listEntitlements(userId: string, db: Db = this.prisma): Promise<UserEntitlement[]> {
    return db.userEntitlement.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }] });
  }

  /**
   * Idempotent on the (userId, entitlement, source, sourceRef) key: re-granting
   * from the same source updates the existing row's status/expiry instead of
   * creating a duplicate entitlement.
   *
   * Implemented as find-then-update/create rather than Prisma `upsert`, because
   * Prisma cannot express a NULL value inside a compound-unique `where`
   * selector (sourceRef is nullable). The DB-level unique index still guards the
   * common non-null case against concurrent duplicates; this find handles the
   * read-modify-write within the caller's transaction.
   */
  async upsertEntitlement(input: UpsertEntitlementInput, db: Db = this.prisma): Promise<UserEntitlement> {
    const existing = await db.userEntitlement.findFirst({
      where: {
        userId: input.userId,
        entitlement: input.entitlement,
        source: input.source,
        sourceRef: input.sourceRef,
      },
    });

    if (existing) {
      return db.userEntitlement.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          expiresAt: input.expiresAt,
          ...(input.startsAt ? { startsAt: input.startsAt } : {}),
        },
      });
    }

    return db.userEntitlement.create({
      data: {
        userId: input.userId,
        entitlement: input.entitlement,
        source: input.source,
        sourceRef: input.sourceRef,
        status: input.status,
        startsAt: input.startsAt ?? new Date(),
        expiresAt: input.expiresAt,
      },
    });
  }

  /** Active, non-expired entitlements of a type — used to recompute the cache. */
  findActiveEntitlementsOfType(
    userId: string,
    entitlement: EntitlementType,
    now: Date = new Date(),
    db: Db = this.prisma,
  ): Promise<UserEntitlement[]> {
    return db.userEntitlement.findMany({
      where: {
        userId,
        entitlement,
        status: EntitlementStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }

  // ── Reward unlocks ───────────────────────────────────────────────────────────

  /**
   * How many active (non-consumed, non-expired) EXTRA_GROUP_SLOT rewards the
   * user holds. Each row is one rewarded-ad watch granting +1 permanent group
   * slot. consumedAt/expiresAt are NULL today (permanent), but filtered so a
   * future "consume" or expiry policy slots in without changing callers.
   */
  countActiveGroupSlotRewards(userId: string, now: Date = new Date(), db: Db = this.prisma): Promise<number> {
    return db.rewardUnlock.count({
      where: {
        userId,
        rewardType: REWARD_TYPES.EXTRA_GROUP,
        grantedEntitlement: EntitlementType.EXTRA_GROUP_SLOT,
        consumedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }

  /** Persist one earned extra-group slot. `sourceEvent` stores ad metadata for audit. */
  createGroupSlotReward(
    userId: string,
    sourceEvent: Prisma.InputJsonValue | undefined,
    db: Db = this.prisma,
  ): Promise<{ id: string }> {
    return db.rewardUnlock.create({
      data: {
        userId,
        rewardType: REWARD_TYPES.EXTRA_GROUP,
        grantedEntitlement: EntitlementType.EXTRA_GROUP_SLOT,
        quantity: 1,
        expiresAt: null,
        ...(sourceEvent !== undefined ? { sourceEvent } : {}),
      },
      select: { id: true },
    });
  }

  // ── Append-only logs ─────────────────────────────────────────────────────────

  createHistory(input: HistoryInput, db: Db = this.prisma): Promise<EntitlementHistory> {
    return db.entitlementHistory.create({
      data: {
        userId: input.userId,
        entitlement: input.entitlement,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        reason: input.reason,
        relatedPurchaseId: input.relatedPurchaseId ?? null,
        ...(input.effectiveAt ? { effectiveAt: input.effectiveAt } : {}),
      },
    });
  }

  createAuditLog(input: AuditLogInput, db: Db = this.prisma): Promise<{ id: string }> {
    return db.purchaseAuditLog.create({
      data: {
        eventType: input.eventType,
        source: input.source,
        userId: input.userId ?? null,
        purchaseToken: input.purchaseToken ?? null,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        googleMessageId: input.googleMessageId ?? null,
        processedOk: input.processedOk ?? true,
      },
      select: { id: true },
    });
  }

  /** RTDN idempotency probe (used by the later webhook phase). */
  findAuditByGoogleMessageId(googleMessageId: string, db: Db = this.prisma): Promise<{ id: string } | null> {
    return db.purchaseAuditLog.findUnique({
      where: { googleMessageId },
      select: { id: true },
    });
  }

  // ── Legacy premium cache on the user row ──────────────────────────────────────

  /**
   * Writes the denormalized premium cache (`isPremium` + `premiumExpiresAt`).
   * The ONLY place the legacy `isPremium` flag is written from the entitlement
   * path. Never called by a client-driven flow in Phase 2A.
   */
  updatePremiumCache(
    userId: string,
    isPremium: boolean,
    premiumExpiresAt: Date | null,
    db: Db = this.prisma,
  ): Promise<unknown> {
    return db.user.update({
      where: { id: userId },
      data: { isPremium, premiumExpiresAt },
    });
  }
}
