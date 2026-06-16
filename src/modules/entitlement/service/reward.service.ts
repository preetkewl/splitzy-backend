import type { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '../../../utils/logger.js';
import {
  FREE_ACTIVE_GROUP_LIMIT,
  MAX_FREE_REWARD_GROUP_SLOTS,
  PREMIUM_ACTIVE_GROUP_LIMIT,
} from '../constants.js';
import type { Db, EntitlementRepository } from '../repository/entitlement.repository.js';
import type { EntitlementGuardService } from './entitlement-guard.service.js';

/** The user's current group-creation allowance, surfaced to the client. */
export interface GroupAllowance {
  premium: boolean;
  /** Base ceiling before reward slots (2 free / 10 premium). */
  baseLimit: number;
  /** Earned reward slots counted toward the limit (free tier only, capped). */
  bonusSlots: number;
  /** Effective max active owned groups = baseLimit + bonusSlots (premium = baseLimit). */
  limit: number;
  /** True when the user can still earn another group slot from a rewarded ad. */
  rewardAvailable: boolean;
}

export interface GrantRewardResult {
  bonusSlots: number;
  groupLimit: number;
}

/**
 * Owns the rewarded-ad "+1 group slot" unlock and the derived group allowance.
 *
 * The grant is server-authoritative and persisted in `reward_unlocks`, replacing
 * the old device-local bonus so the trip-create enforcement can honour it. One
 * ad → one permanent slot, capped at {@link MAX_FREE_REWARD_GROUP_SLOTS}.
 */
export class RewardService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: EntitlementRepository,
    private readonly guard: EntitlementGuardService,
  ) {}

  /**
   * Records that the user watched a rewarded ad and earns one extra group slot.
   *
   * Race-safe + idempotent: takes the same per-user advisory lock the group-limit
   * enforcement uses, then grants only while under the cap. Repeat calls past the
   * cap are a no-op (return the current allowance) — a double-tap or replayed
   * request never stacks beyond {@link MAX_FREE_REWARD_GROUP_SLOTS}.
   */
  async grantExtraGroupSlot(
    userId: string,
    sourceEvent?: Prisma.InputJsonValue,
  ): Promise<GrantRewardResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

      const existing = await this.repo.countActiveGroupSlotRewards(userId, new Date(), tx);
      if (existing < MAX_FREE_REWARD_GROUP_SLOTS) {
        await this.repo.createGroupSlotReward(userId, sourceEvent, tx);
        logger.info({ userId, rewardSlots: existing + 1 }, 'extra group slot granted (rewarded ad)');
      } else {
        logger.info({ userId, rewardSlots: existing }, 'extra group slot grant skipped (cap reached)');
      }

      const allowance = await this.getGroupAllowance(userId, tx);
      return { bonusSlots: allowance.bonusSlots, groupLimit: allowance.limit };
    });
  }

  /**
   * Computes the user's effective group allowance. Authoritative read used by
   * both the limit enforcement and `/auth/me` (so the client knows the cap and
   * whether a reward is still available without trial-and-error).
   */
  async getGroupAllowance(userId: string, db?: Db): Promise<GroupAllowance> {
    const premium = await this.guard.isPremium(userId, db);
    if (premium) {
      return {
        premium: true,
        baseLimit: PREMIUM_ACTIVE_GROUP_LIMIT,
        bonusSlots: 0,
        limit: PREMIUM_ACTIVE_GROUP_LIMIT,
        rewardAvailable: false,
      };
    }

    const earned = await this.repo.countActiveGroupSlotRewards(userId, new Date(), db);
    const bonusSlots = Math.min(earned, MAX_FREE_REWARD_GROUP_SLOTS);
    return {
      premium: false,
      baseLimit: FREE_ACTIVE_GROUP_LIMIT,
      bonusSlots,
      limit: FREE_ACTIVE_GROUP_LIMIT + bonusSlots,
      rewardAvailable: bonusSlots < MAX_FREE_REWARD_GROUP_SLOTS,
    };
  }
}
