import type { PrismaClient, UserEntitlement } from '@prisma/client';
import { METRICS } from '../../../constants/metrics.js';
import { incMetric } from '../../../utils/metrics.js';
import type { EntitlementChangeReason, EntitlementSource } from '../constants.js';
// Used as runtime values (status derivation / default entitlement type).
import { EntitlementStatus, EntitlementType } from '../constants.js';
import type { Db, EntitlementRepository } from '../repository/entitlement.repository.js';

export interface GrantEntitlementParams {
  userId: string;
  entitlement: EntitlementType;
  source: EntitlementSource;
  /** Granting record id within its source domain (e.g. SubscriptionPurchase.id). */
  sourceRef: string | null;
  /** NULL = perpetual (admin/promo). For subscriptions, the period end. */
  expiresAt: Date | null;
  reason: EntitlementChangeReason;
  relatedPurchaseId?: string | null;
  startsAt?: Date;
}

export interface EntitlementSnapshot {
  isPremium: boolean;
  /** Furthest-out active premium expiry, or null if perpetual / none. */
  premiumExpiresAt: Date | null;
}

/**
 * Entitlement foundation — derivation, reads, idempotent grants, history.
 *
 * This is the backend's source of truth for "what can a user do". In Phase 2A
 * it is wired to nothing (no verification calls it, no middleware reads it), so
 * adding it changes no live behaviour. It exists so the verification/RTDN
 * phases call `grant`/`revoke`/`expire` and the enforcement phase reads
 * `hasEntitlement`.
 *
 * Writes that touch more than one row (entitlement + history + user cache) run
 * inside a single transaction so the derived state can never be left partial.
 */
export class EntitlementService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: EntitlementRepository,
  ) {}

  // ── Pure derivation ──────────────────────────────────────────────────────────

  /**
   * Derive the on/off status of an entitlement from its expiry alone. ACTIVE if
   * perpetual (null) or still in the future; EXPIRED otherwise. (Revocation is a
   * separate, explicit transition — never inferred from time.)
   */
  static deriveStatus(expiresAt: Date | null, now: Date = new Date()): EntitlementStatus {
    if (expiresAt === null) return EntitlementStatus.ACTIVE;
    return expiresAt.getTime() > now.getTime() ? EntitlementStatus.ACTIVE : EntitlementStatus.EXPIRED;
  }

  // ── Reads (non-authoritative use only in Phase 2A) ───────────────────────────

  getActiveEntitlement(
    userId: string,
    entitlement: EntitlementType = EntitlementType.PREMIUM,
    now: Date = new Date(),
  ): Promise<UserEntitlement | null> {
    return this.repo.findActiveEntitlement(userId, entitlement, now);
  }

  async hasEntitlement(
    userId: string,
    entitlement: EntitlementType = EntitlementType.PREMIUM,
    now: Date = new Date(),
  ): Promise<boolean> {
    return (await this.repo.findActiveEntitlement(userId, entitlement, now)) !== null;
  }

  listEntitlements(userId: string): Promise<UserEntitlement[]> {
    return this.repo.listEntitlements(userId);
  }

  // ── Transitions (transactional, history-recording) ───────────────────────────

  /**
   * Grant or renew an entitlement in its own transaction. Idempotent on its
   * source key, so re-running verification for the same purchase updates the
   * expiry rather than stacking grants.
   */
  grant(params: GrantEntitlementParams): Promise<UserEntitlement> {
    return this.prisma.$transaction((tx) => this.grantWithinTx(tx, params));
  }

  /**
   * Core grant logic, run inside a caller-owned transaction. Lets the
   * verification flow do purchase-upsert + grant + audit atomically without a
   * nested transaction (Prisma does not support those). Records a history row
   * and refreshes the legacy premium cache.
   */
  async grantWithinTx(db: Db, params: GrantEntitlementParams): Promise<UserEntitlement> {
    const status = EntitlementService.deriveStatus(params.expiresAt, params.startsAt ?? new Date());
    const prior = await this.repo.findActiveEntitlement(params.userId, params.entitlement, new Date(), db);

    const entitlement = await this.repo.upsertEntitlement(
      {
        userId: params.userId,
        entitlement: params.entitlement,
        source: params.source,
        sourceRef: params.sourceRef,
        status,
        expiresAt: params.expiresAt,
        ...(params.startsAt ? { startsAt: params.startsAt } : {}),
      },
      db,
    );

    await this.repo.createHistory(
      {
        userId: params.userId,
        entitlement: params.entitlement,
        fromStatus: prior ? prior.status : null,
        toStatus: status,
        reason: params.reason,
        relatedPurchaseId: params.relatedPurchaseId ?? null,
      },
      db,
    );

    await this.refreshPremiumCache(params.userId, db);
    incMetric(METRICS.entitlementGranted, { entitlement: params.entitlement, source: params.source, status });
    return entitlement;
  }

  /**
   * Explicitly close an entitlement (refund/revoke → REVOKED, lapse → EXPIRED),
   * in its own transaction. No-op-safe: if no active row exists, nothing is
   * written.
   */
  close(
    userId: string,
    entitlement: EntitlementType,
    // Prisma generates EntitlementStatus as a const-object union, not a TS enum,
    // so we narrow with the literal value types rather than `EnumName.MEMBER`.
    toStatus: typeof EntitlementStatus.EXPIRED | typeof EntitlementStatus.REVOKED,
    reason: EntitlementChangeReason,
    relatedPurchaseId?: string | null,
  ): Promise<void> {
    return this.prisma.$transaction((tx) =>
      this.closeWithinTx(tx, userId, entitlement, toStatus, reason, relatedPurchaseId),
    );
  }

  /** Core close logic, run inside a caller-owned transaction. */
  async closeWithinTx(
    db: Db,
    userId: string,
    entitlement: EntitlementType,
    toStatus: typeof EntitlementStatus.EXPIRED | typeof EntitlementStatus.REVOKED,
    reason: EntitlementChangeReason,
    relatedPurchaseId?: string | null,
  ): Promise<void> {
    const active = await this.repo.findActiveEntitlement(userId, entitlement, new Date(), db);
    if (!active) return;

    await this.repo.upsertEntitlement(
      {
        userId: active.userId,
        entitlement: active.entitlement,
        source: active.source,
        sourceRef: active.sourceRef,
        status: toStatus,
        expiresAt: active.expiresAt,
      },
      db,
    );

    await this.repo.createHistory(
      {
        userId,
        entitlement,
        fromStatus: active.status,
        toStatus,
        reason,
        relatedPurchaseId: relatedPurchaseId ?? null,
      },
      db,
    );

    await this.refreshPremiumCache(userId, db);
    incMetric(METRICS.entitlementRevoked, { entitlement, status: toStatus });
  }

  // ── Legacy cache bridge ───────────────────────────────────────────────────────

  /**
   * Recompute `users.isPremium` + `users.premiumExpiresAt` from the user's
   * active PREMIUM entitlements, inside the caller's transaction. Keeps the
   * deprecated flag coherent with the new source of truth so existing readers
   * (toUserDto, /auth/me) stay correct once entitlements drive premium.
   *
   * A perpetual grant (null expiry) → premium with null expiry. Otherwise the
   * cache holds the furthest-out expiry across active grants.
   */
  private async refreshPremiumCache(userId: string, db: Db): Promise<EntitlementSnapshot> {
    const active = await this.repo.findActiveEntitlementsOfType(
      userId,
      EntitlementType.PREMIUM,
      new Date(),
      db,
    );

    const isPremium = active.length > 0;
    const hasPerpetual = active.some((e) => e.expiresAt === null);
    const premiumExpiresAt = hasPerpetual
      ? null
      : active.reduce<Date | null>((max, e) => {
          if (e.expiresAt === null) return max;
          return max === null || e.expiresAt > max ? e.expiresAt : max;
        }, null);

    await this.repo.updatePremiumCache(userId, isPremium, premiumExpiresAt, db);
    return { isPremium, premiumExpiresAt };
  }
}
