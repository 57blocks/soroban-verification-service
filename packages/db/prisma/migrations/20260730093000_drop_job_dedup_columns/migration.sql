-- ADR-008: a job no longer owns its build.
--
-- `idempotency_key` identified a *rebuild* recipe, and being UNIQUE on this table is exactly what
-- forced every submission sharing a recipe onto one row — and therefore onto one verdict. It now
-- lives on `rebuilds`. `batch_job_id`/`build_mode` describe a Batch attempt, which belongs to the
-- rebuild that runs it, not to any one of the jobs whose verdicts that rebuild feeds.
--
-- Destructive: drops values from existing rows (dropping a column also drops the indexes and
-- constraints defined on it, including `jobs_idempotency_key_key`). Nothing reads these columns any
-- more, and no published artifact is derived from them.

-- DropIndex (implicit in Postgres when the column goes, stated for the reader)
-- "jobs_idempotency_key_key" UNIQUE on ("idempotency_key")

-- AlterTable
ALTER TABLE "jobs"
  DROP COLUMN "idempotency_key",
  DROP COLUMN "batch_job_id",
  DROP COLUMN "build_mode";
