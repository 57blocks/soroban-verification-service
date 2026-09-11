-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "archive_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "archive_pending_since" TIMESTAMP(3),
ADD COLUMN     "archived_tx_id" TEXT;

-- CreateIndex
CREATE INDEX "jobs_archive_pending_since_idx" ON "jobs"("archive_pending_since");
