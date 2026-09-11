-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "source_archive_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "source_archive_pending_since" TIMESTAMP(3),
ADD COLUMN     "source_archived_tx_id" TEXT;

-- CreateIndex
CREATE INDEX "jobs_source_archive_pending_since_idx" ON "jobs"("source_archive_pending_since");
