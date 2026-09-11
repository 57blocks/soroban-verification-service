-- Raw build-log access: docs/features/build-log-access/design.md BL-1..BL-3.
--
-- Raw build-log access stops being authorised by the job id — which is the URL a submitter shares — and
-- becomes a per-job token whose sha256 is all that is stored. The log also stops being retained
-- indefinitely.
--
-- All three columns are nullable or defaulted and NOTHING is backfilled, deliberately:
--
--   * `build_log_token_hash` NULL means "no token was ever minted for this job", which is every job
--     created before this migration. Those jobs answer 401 for a token that cannot exist rather than
--     serving the log to the job id — the old model is closed for them too, and it is closed by the
--     absence of a value rather than by a rule someone has to remember.
--   * `build_log_expires_at` NULL means "no expiry recorded". `listExpiredBuildLogs` therefore does not
--     select these rows, and the 30-day job-retention sweep is what eventually removes their logs.
--     Stamping a retroactive expiry from `updated_at` would be inventing a completion time the row does
--     not carry (the same reason `completed_at` was not backfilled in 20260903000000).
--
-- The index is the sweep's access path; nothing reads these columns in bulk otherwise.

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "build_log_token_hash" TEXT;
ALTER TABLE "jobs" ADD COLUMN "build_log_expires_at" TIMESTAMP(3);
ALTER TABLE "jobs" ADD COLUMN "build_log_hold" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "jobs_build_log_expires_at_idx" ON "jobs"("build_log_expires_at");
