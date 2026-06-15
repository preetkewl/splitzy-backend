-- Monetization Phase 2A — entitlement foundation.
--
-- PURELY ADDITIVE. This migration only CREATEs new enums/tables/indexes and
-- adds one NULLABLE column to "users" ("premiumExpiresAt"). It does NOT touch,
-- rename, or drop any existing column — the legacy User subscription fields
-- (isPremium, subscriptionToken, subscriptionProductId, subscriptionExpiresAt)
-- are deliberately left in place so the current premium flow keeps working
-- unchanged. Safe to deploy ahead of any verification/RTDN/enforcement code:
-- nothing reads these tables yet.
--
-- Columns are camelCase (matching the existing "users" table), so they line up
-- with what the generated Prisma client queries.
--
-- Reset path (closed testing — data is disposable):
--   npx prisma migrate reset --force

-- CreateEnum
CREATE TYPE "EntitlementType" AS ENUM ('PREMIUM');

-- CreateEnum
CREATE TYPE "EntitlementSource" AS ENUM ('SUBSCRIPTION', 'REWARD', 'GRANT', 'PROMO');

-- CreateEnum
CREATE TYPE "EntitlementStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SubscriptionState" AS ENUM ('PENDING', 'ACTIVE', 'CANCELED', 'IN_GRACE_PERIOD', 'ON_HOLD', 'PAUSED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('VERIFY_REQUESTED', 'VERIFY_SUCCEEDED', 'VERIFY_FAILED', 'PURCHASE_RECORDED', 'PURCHASE_UPDATED', 'ENTITLEMENT_GRANTED', 'ENTITLEMENT_RENEWED', 'ENTITLEMENT_REVOKED', 'ENTITLEMENT_EXPIRED', 'RTDN_RECEIVED');

-- CreateEnum
CREATE TYPE "AuditSource" AS ENUM ('CLIENT', 'RTDN', 'SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "EntitlementChangeReason" AS ENUM ('PURCHASE_VERIFIED', 'RENEWAL', 'CANCELLATION', 'EXPIRY', 'REVOCATION', 'ADMIN_GRANT', 'REWARD_GRANT', 'BACKFILL');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "premiumExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "subscription_purchases" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purchaseToken" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "orderId" TEXT,
    "state" "SubscriptionState" NOT NULL DEFAULT 'PENDING',
    "purchasedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "autoRenewing" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "linkedPurchaseToken" TEXT,
    "latestGoogleState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_entitlements" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "entitlement" "EntitlementType" NOT NULL,
    "source" "EntitlementSource" NOT NULL,
    "sourceRef" TEXT,
    "status" "EntitlementStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_audit_log" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "purchaseToken" TEXT,
    "eventType" "AuditEventType" NOT NULL,
    "source" "AuditSource" NOT NULL DEFAULT 'SYSTEM',
    "payload" JSONB,
    "googleMessageId" TEXT,
    "processedOk" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_history" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "entitlement" "EntitlementType" NOT NULL,
    "fromStatus" "EntitlementStatus",
    "toStatus" "EntitlementStatus" NOT NULL,
    "reason" "EntitlementChangeReason" NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "relatedPurchaseId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_tracking" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "quotaKey" TEXT NOT NULL,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "limitOverride" INTEGER,
    "periodStart" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quota_tracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_unlocks" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "rewardType" TEXT NOT NULL,
    "grantedEntitlement" "EntitlementType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "sourceEvent" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_unlocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_purchases_purchaseToken_key" ON "subscription_purchases"("purchaseToken");

-- CreateIndex
CREATE INDEX "subscription_purchases_userId_idx" ON "subscription_purchases"("userId");

-- CreateIndex
CREATE INDEX "subscription_purchases_state_expiresAt_idx" ON "subscription_purchases"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "subscription_purchases_orderId_idx" ON "subscription_purchases"("orderId");

-- CreateIndex
CREATE INDEX "user_entitlements_userId_entitlement_status_idx" ON "user_entitlements"("userId", "entitlement", "status");

-- CreateIndex
CREATE INDEX "user_entitlements_status_expiresAt_idx" ON "user_entitlements"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_entitlements_userId_entitlement_source_sourceRef_key" ON "user_entitlements"("userId", "entitlement", "source", "sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_audit_log_googleMessageId_key" ON "purchase_audit_log"("googleMessageId");

-- CreateIndex
CREATE INDEX "purchase_audit_log_purchaseToken_idx" ON "purchase_audit_log"("purchaseToken");

-- CreateIndex
CREATE INDEX "purchase_audit_log_userId_idx" ON "purchase_audit_log"("userId");

-- CreateIndex
CREATE INDEX "purchase_audit_log_createdAt_idx" ON "purchase_audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "entitlement_history_userId_entitlement_idx" ON "entitlement_history"("userId", "entitlement");

-- CreateIndex
CREATE INDEX "entitlement_history_createdAt_idx" ON "entitlement_history"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "quota_tracking_userId_quotaKey_periodStart_key" ON "quota_tracking"("userId", "quotaKey", "periodStart");

-- CreateIndex
CREATE INDEX "reward_unlocks_userId_rewardType_idx" ON "reward_unlocks"("userId", "rewardType");

-- AddForeignKey
ALTER TABLE "subscription_purchases" ADD CONSTRAINT "subscription_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_entitlements" ADD CONSTRAINT "user_entitlements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_tracking" ADD CONSTRAINT "quota_tracking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_unlocks" ADD CONSTRAINT "reward_unlocks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
