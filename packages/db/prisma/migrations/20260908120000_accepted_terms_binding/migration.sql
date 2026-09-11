-- The per-job terms binding: docs/features/versioned-terms-and-assent/design.md TA-3, TA-5.
--
-- A job records the terms version its submitter accepted and the sha256 of the bytes served under that
-- version. Two columns rather than one because they answer different questions: the version is what a
-- reader is shown and what an operator publishes a change against, the hash is the evidence of *which
-- words* — a version string alone cannot supply that, because a label can be edited under.
--
-- Both nullable and NOTHING is backfilled:
--
--   * NULL/NULL means "created before assent was recorded", which is every existing job. There is no
--     value that could be invented here: nobody accepted anything, and writing the current version onto
--     an old row would assert a submitter's agreement that never happened.
--   * NULL/NULL is also what a submission made while the operator's document declares no effective date
--     produces (TA-7). Those two cases are deliberately indistinguishable in the row: neither carries an
--     accepted version, because in neither did the submitter accept one.
--
-- The index serves the boot-time check that no job asserts a version whose text has since changed
-- (TA-5) — a `WHERE accepted_terms_version = $1 AND accepted_terms_sha256 <> $2` probe. Nothing reads
-- these columns in bulk otherwise, and that check is why the property needs no separate versions table.

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "accepted_terms_version" TEXT;
ALTER TABLE "jobs" ADD COLUMN "accepted_terms_sha256" TEXT;

-- CreateIndex
CREATE INDEX "jobs_accepted_terms_version_idx" ON "jobs"("accepted_terms_version");
