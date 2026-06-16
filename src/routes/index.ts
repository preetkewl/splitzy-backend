import { Router } from 'express';
import { createActivityModule } from '../modules/activity/index.js';
import { createAuthModule } from '../modules/auth/index.js';
import { createDashboardModule } from '../modules/dashboard/index.js';
import { createEntitlementModule, createRewardRouter, RewardController } from '../modules/entitlement/index.js';
import { createExpenseModule } from '../modules/expense/index.js';
import { createFriendModule } from '../modules/friend/index.js';
import { healthRouter } from '../modules/health/routes/health.routes.js';
import { createNotificationModule } from '../modules/notification/index.js';
import { createSettlementModule } from '../modules/settlement/index.js';
import { createSubscriptionModule } from '../modules/subscription/index.js';
import { createTripModule } from '../modules/trip/index.js';

/**
 * Top-level API router. Each business module mounts its own sub-router
 * here. Keeping this file as the single mount-point keeps the API
 * surface easy to audit.
 */
export function createApiRouter(): Router {
  const router = Router();

  // Monetization: the entitlement module owns the source-of-truth services and
  // the authoritative enforcement (limits/guard/rewards). Built FIRST so its
  // group-allowance resolver can ride on `/auth/me` and the trip module can
  // enforce the group limit server-side.
  const entitlement = createEntitlementModule();

  const auth = createAuthModule({
    groupAllowance: (userId) => entitlement.rewards.getGroupAllowance(userId),
  });

  // Notification module is built first — its service is injected into every
  // other module that fires push notifications.
  const notificationModule = createNotificationModule({ tokens: auth.tokens });
  const { service: notifications } = notificationModule;

  // Activity module is built early too — its service is injected (alongside
  // notifications) into every module that emits a feed event. Writes are
  // fire-and-forget, so this never couples to the business write paths.
  const activityModule = createActivityModule({ tokens: auth.tokens });
  const { service: activity } = activityModule;

  const trips = createTripModule({ tokens: auth.tokens, activity, limits: entitlement.limits });

  // Rewarded-ad unlock endpoints, mounted at `/me` (shares the mount with the
  // dashboard router).
  const rewardRouter = createRewardRouter({
    controller: new RewardController(entitlement.rewards),
    tokens: auth.tokens,
  });
  // Settlements are built first so the Expense module can read from the
  // same repository when computing balances — no double-wiring.
  const settlements = createSettlementModule({ tokens: auth.tokens, notifications, activity });
  const expenses = createExpenseModule({
    tokens: auth.tokens,
    settlements: settlements.repository,
    notifications,
    activity,
  });
  const friends = createFriendModule({ tokens: auth.tokens, notifications, activity });
  const subscription = createSubscriptionModule({
    tokens: auth.tokens,
    verification: entitlement.verification,
    rtdn: entitlement.rtdn,
  });
  // Read-only aggregation endpoint — collapses the Home fan-out.
  const dashboard = createDashboardModule({ tokens: auth.tokens });

  router.use('/health', healthRouter);
  router.use('/auth', auth.router);
  // Three routers share the `/trips` mount: the trip module owns CRUD,
  // the expense module owns `/expenses` + `/balances`, and the settlement
  // module owns `/settlements`.
  router.use('/trips', trips.router);
  router.use('/trips', expenses.tripScopedRouter);
  router.use('/trips', settlements.tripScopedRouter);
  router.use('/expenses', expenses.rootRouter);
  router.use('/settlements', settlements.rootRouter);
  router.use('/friends', friends.router);
  router.use('/notifications', notificationModule.router);
  router.use('/activity', activityModule.router);
  router.use('/me', dashboard.router);
  router.use('/me', rewardRouter);
  router.use('/subscriptions', subscription.router);

  return router;
}
