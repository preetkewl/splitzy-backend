-- Adds the EXTRA_GROUP_SLOT entitlement type used by the rewarded-ad "+1 group"
-- unlock. Enum-only migration: a new EntitlementType value must be added in its
-- own migration (no table DDL) so PostgreSQL can extend the type safely.
ALTER TYPE "EntitlementType" ADD VALUE 'EXTRA_GROUP_SLOT';
