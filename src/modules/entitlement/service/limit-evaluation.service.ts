import { ERROR_CODES } from '../../../constants/error-codes.js';
import { HTTP } from '../../../constants/http.js';
import { ApiError } from '../../../core/api-error.js';
import { logger } from '../../../utils/logger.js';
import { QUOTA_KEYS } from '../constants.js';
import type { Db } from '../repository/entitlement.repository.js';
import type { RewardService } from './reward.service.js';

export interface GroupLimitDecision {
  allowed: boolean;
  premium: boolean;
  /** Current active (non-deleted) owned-group count. */
  usage: number;
  /** Effective ceiling (free: 2 + reward slots; premium: 10). */
  limit: number;
  /** Free tier only: can the user unlock one more slot via a rewarded ad? */
  rewardAvailable: boolean;
}

/** Supplies the current active-group count, run inside the caller's transaction. */
export type CountActiveGroups = () => Promise<number>;

/**
 * Authoritative quota evaluation + enforcement. Domain-agnostic: the active
 * count is provided by the caller (the trip module), so this service never
 * reaches into the trip schema. The effective ceiling comes from
 * {@link RewardService.getGroupAllowance} (free = 2 + earned reward slots,
 * capped at 3; premium = hard cap of 10), keeping allowance math in one place.
 */
export class LimitEvaluationService {
  constructor(private readonly reward: RewardService) {}

  async evaluateGroupCreation(
    userId: string,
    countActive: CountActiveGroups,
    db?: Db,
  ): Promise<GroupLimitDecision> {
    const allowance = await this.reward.getGroupAllowance(userId, db);
    const usage = await countActive();
    return {
      allowed: usage < allowance.limit,
      premium: allowance.premium,
      usage,
      limit: allowance.limit,
      rewardAvailable: allowance.rewardAvailable,
    };
  }

  /**
   * Race-safe enforcement. MUST be called inside a transaction that also
   * performs the insert: it takes a transaction-scoped Postgres advisory lock
   * keyed on the user, then evaluates. Two concurrent "create group" requests
   * for the same user serialize on the lock, so they cannot both pass the count
   * (multi-device / double-tap safe). The lock auto-releases on commit/rollback.
   * The same lock key serializes reward grants, so a slot can't be earned and
   * spent in two racing transactions.
   */
  async enforceGroupCreation(db: Db, userId: string, countActive: CountActiveGroups): Promise<void> {
    await this.lockUser(db, userId);
    const decision = await this.evaluateGroupCreation(userId, countActive, db);
    if (!decision.allowed) {
      logger.warn(
        { userId, quota: QUOTA_KEYS.ACTIVE_GROUPS, usage: decision.usage, limit: decision.limit, premium: decision.premium },
        'group creation blocked by group limit',
      );
      throw decision.premium ? premiumGroupLimitError(decision) : freeGroupLimitError(decision);
    }
  }

  private async lockUser(db: Db, userId: string): Promise<void> {
    // hashtext(uuid) → int4, widened to bigint for the advisory key. The xact
    // lock is held until this transaction ends.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
  }
}

export function freeGroupLimitError(decision: GroupLimitDecision): ApiError {
  const message = decision.rewardAvailable
    ? `Free plan is limited to ${String(decision.limit)} active groups. Watch a short ad to unlock one more, or upgrade to Premium.`
    : `Free plan is limited to ${String(decision.limit)} active groups. Upgrade to Premium for more.`;
  return new ApiError(HTTP.FORBIDDEN, ERROR_CODES.FREE_GROUP_LIMIT_REACHED, message, {
    meta: {
      usage: decision.usage,
      limit: decision.limit,
      premium: decision.premium,
      rewardAvailable: decision.rewardAvailable,
    },
  });
}

export function premiumGroupLimitError(decision: GroupLimitDecision): ApiError {
  return new ApiError(
    HTTP.FORBIDDEN,
    ERROR_CODES.PREMIUM_GROUP_LIMIT_REACHED,
    `Premium is limited to ${String(decision.limit)} active groups.`,
    { meta: { usage: decision.usage, limit: decision.limit, premium: true, rewardAvailable: false } },
  );
}

export function premiumRequiredError(): ApiError {
  return new ApiError(HTTP.FORBIDDEN, ERROR_CODES.PREMIUM_REQUIRED, 'This feature requires Settlio Premium.', {
    meta: { premium: false },
  });
}
