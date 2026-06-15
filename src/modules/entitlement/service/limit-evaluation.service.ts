import { ERROR_CODES } from '../../../constants/error-codes.js';
import { HTTP } from '../../../constants/http.js';
import { ApiError } from '../../../core/api-error.js';
import { logger } from '../../../utils/logger.js';
import { FREE_ACTIVE_GROUP_LIMIT, QUOTA_KEYS } from '../constants.js';
import type { Db } from '../repository/entitlement.repository.js';
import type { EntitlementGuardService } from './entitlement-guard.service.js';

export interface GroupLimitDecision {
  allowed: boolean;
  premium: boolean;
  /** Current active-group count. null when premium (unlimited, not counted). */
  usage: number | null;
  /** Free-tier ceiling. null when premium (unlimited). */
  limit: number | null;
}

/** Supplies the current active-group count, run inside the caller's transaction. */
export type CountActiveGroups = () => Promise<number>;

/**
 * Authoritative quota evaluation + enforcement. Domain-agnostic: the active
 * count is provided by the caller (the trip module), so this service never
 * reaches into the trip schema. Premium → unlimited; free → capped.
 *
 * Extensible: additional quotas slot in as new evaluate/enforce methods keyed by
 * {@link QUOTA_KEYS}; reward-unlock / admin-grant overrides will later widen the
 * effective limit here (deferred — not implemented yet).
 */
export class LimitEvaluationService {
  constructor(private readonly guard: EntitlementGuardService) {}

  async evaluateGroupCreation(
    userId: string,
    countActive: CountActiveGroups,
    db?: Db,
  ): Promise<GroupLimitDecision> {
    const premium = await this.guard.isPremium(userId, db);
    if (premium) return { allowed: true, premium: true, usage: null, limit: null };

    const usage = await countActive();
    const limit = FREE_ACTIVE_GROUP_LIMIT;
    return { allowed: usage < limit, premium: false, usage, limit };
  }

  /**
   * Race-safe enforcement. MUST be called inside a transaction that also
   * performs the insert: it takes a transaction-scoped Postgres advisory lock
   * keyed on the user, then evaluates. Two concurrent "create group" requests
   * for the same user serialize on the lock, so they cannot both pass the count
   * (multi-device / double-tap safe). The lock auto-releases on commit/rollback.
   */
  async enforceGroupCreation(db: Db, userId: string, countActive: CountActiveGroups): Promise<void> {
    await this.lockUser(db, userId);
    const decision = await this.evaluateGroupCreation(userId, countActive, db);
    if (!decision.allowed) {
      logger.warn(
        { userId, quota: QUOTA_KEYS.ACTIVE_GROUPS, usage: decision.usage, limit: decision.limit },
        'group creation blocked by free-tier limit',
      );
      throw freeGroupLimitError(decision);
    }
  }

  private async lockUser(db: Db, userId: string): Promise<void> {
    // hashtext(uuid) → int4, widened to bigint for the advisory key. The xact
    // lock is held until this transaction ends.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
  }
}

export function freeGroupLimitError(decision: GroupLimitDecision): ApiError {
  return new ApiError(
    HTTP.FORBIDDEN,
    ERROR_CODES.FREE_GROUP_LIMIT_REACHED,
    `Free plan is limited to ${String(FREE_ACTIVE_GROUP_LIMIT)} active groups. Upgrade to Premium for unlimited groups.`,
    { meta: { usage: decision.usage, limit: decision.limit, premium: decision.premium } },
  );
}

export function premiumRequiredError(): ApiError {
  return new ApiError(HTTP.FORBIDDEN, ERROR_CODES.PREMIUM_REQUIRED, 'This feature requires Settlio Premium.', {
    meta: { premium: false },
  });
}
