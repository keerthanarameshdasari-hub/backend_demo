-- Reverses migration.sql. Run with:
--   npx prisma db execute --file prisma/migrations/20261030000000_init/down.sql
-- The last statement removes this migration from Prisma's history, so a later
-- `prisma migrate deploy` applies it again.

-- DropForeignKey
ALTER TABLE "public"."kyc_submissions" DROP CONSTRAINT "kyc_submissions_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."wallets" DROP CONSTRAINT "wallets_user_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."top_ups" DROP CONSTRAINT "top_ups_user_id_fkey";

-- DropTable
DROP TABLE "public"."users";

-- DropTable
DROP TABLE "public"."kyc_submissions";

-- DropTable
DROP TABLE "public"."wallets";

-- DropTable
DROP TABLE "public"."top_ups";

-- DropEnum
DROP TYPE "public"."KycStatus";

-- DropEnum
DROP TYPE "public"."DocumentType";

-- DropEnum
DROP TYPE "public"."TopUpStatus";



-- Forget this migration
DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = '20261030000000_init';
