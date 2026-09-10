-- Counts failed attempts at publishing a job's already-computed verdict.
--
-- A job that settles with a verdict but whose artifact write fails stays in `comparing` and is
-- retried by scheduler/publish-recovery.scheduler.ts. That retry had no counter and no bound, so a
-- misconfigured publisher produced an infinite silent retry loop: from the outside the job was
-- indistinguishable from one still waiting on its sandbox rebuild. This column is what lets the scan
-- stop, and what lets the count be reported to the submitter.
--
-- Additive and non-destructive: NOT NULL with a DEFAULT, so existing rows backfill to 0 and are
-- treated as "never attempted", which is the correct reading for any row written before this column
-- existed. Set it back to 0 to re-arm the retry after fixing publisher configuration.

-- AlterTable
ALTER TABLE "jobs"
  ADD COLUMN "publish_attempts" INTEGER NOT NULL DEFAULT 0;
