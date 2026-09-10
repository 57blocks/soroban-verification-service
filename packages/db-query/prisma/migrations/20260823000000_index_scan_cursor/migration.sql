-- AlterTable
ALTER TABLE "verifier_sync_cursor" ADD COLUMN     "first_cycle_completed_at" TIMESTAMP(3),
ADD COLUMN     "index_cursor" TEXT;
