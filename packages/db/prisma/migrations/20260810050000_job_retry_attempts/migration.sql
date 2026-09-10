-- TRD §7.6 Rule D: retryable failures are re-queued, bounded by a persisted counter.
--
-- Defaults to 0 on every existing row, which is why `JobRetryScheduler` also filters on
-- `updated_at` — without that window the first scan after deploy would re-queue every historical
-- `internal_error` and `build_timeout` job at once.

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "retry_attempts" INTEGER NOT NULL DEFAULT 0;
