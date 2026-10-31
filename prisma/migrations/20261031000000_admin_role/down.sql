-- Reverses migration.sql. Run with:
--   npx prisma db execute --file prisma/migrations/20261031000000_admin_role/down.sql
-- Every user goes back to having no role, and the record of which admin
-- overrode a KYC decision is lost. The decisions themselves are kept.
-- The last statement removes this migration from Prisma's history, so a later
-- `prisma migrate deploy` applies it again.

-- DropForeignKey
ALTER TABLE "public"."kyc_submissions" DROP CONSTRAINT "kyc_submissions_reviewed_by_fkey";

-- DropIndex
DROP INDEX "public"."kyc_submissions_status_created_at_idx";

-- DropIndex
DROP INDEX "public"."top_ups_created_at_idx";

-- DropIndex
DROP INDEX "public"."users_created_at_idx";

-- AlterTable
ALTER TABLE "public"."kyc_submissions" DROP COLUMN "reviewed_by";

-- AlterTable
ALTER TABLE "public"."users" DROP COLUMN "role";

-- DropEnum
DROP TYPE "public"."UserRole";

-- Forget this migration
DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = '20261031000000_admin_role';
