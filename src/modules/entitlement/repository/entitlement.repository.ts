import type {
  AuditEventType,
  AuditSource,
  EntitlementChangeReason,
  EntitlementHistory,
  EntitlementSource,
  EntitlementType,
  Prisma,
  PrismaClient,
  SubscriptionPurchase,
  UserEntitlement,
} from '@prisma/client';
// Used as runtime values (defaults / query filters), so a value import.
import { EntitlementStatus, SubscriptionState } from '@prisma/client';

/**
 * Any Prisma executor — the base client or an interactive-transaction client.
 * Repository methods accept one so a service can run several writes atomically
 * inside `prisma.$transaction(tx => …)` while still reusing the same data
 * access code outside a transaction.
 */
export type Db = PrismaClient | Prisma.TransactionClient;

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
   * repeat verify this UPDATES the existing row in place (no duplicate). The
   * unique constraint on purchaseToken still guards a concurrent race; the
   * cross-user ownership check is enforced in the service before this runs.
   */
  upsertVerifiedPurchase(input: VerifiedPurchaseInput, db: Db = this.prisma): Promise<SubscriptionPurchase> {
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
    return db.subscriptionPurchase.upsert({
      where: { purchaseToken: input.purchaseToken },
      create: { userId: input.userId, purchaseToken: input.purchaseToken, ...shared },
      update: shared,
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
