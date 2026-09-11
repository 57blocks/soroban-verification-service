-- TRD §4.3/§4.5: a mismatch is a *successful verification*, not a job failure.
--
-- Ships in the same migration as the widened `failure_reason` vocabulary, because both halves of
-- that statement have to be true at once: `hash_mismatch` leaves the taxonomy, and the rows that
-- carried it become published jobs holding a `mismatched` verdict.

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "verdict" TEXT;

-- A mismatch was never a job failure. `published` is already a legal `status` value, so this
-- rewrites no state the shipped `jobStatuses` cannot read.
UPDATE "jobs"
   SET "status" = 'published',
       "verdict" = 'mismatched',
       "failure_reason" = NULL
 WHERE "failure_reason" = 'hash_mismatch';

-- Backfill the verdict for everything already published. Derived from the result summary the job
-- already carries rather than assumed: a published job without one is left null rather than
-- claiming an answer that was never recorded.
UPDATE "jobs"
   SET "verdict" = 'verified'
 WHERE "status" = 'published'
   AND "verdict" IS NULL
   AND "result_summary"->>'status_summary' = 'verified';

-- Both statements are no-ops on a database with no such rows, which is what
-- docs/features/dedup-and-lifecycle/notes.md's Phase 0 count confirmed locally. Re-running this
-- migration is therefore safe: the first matches nothing once `hash_mismatch` is gone, and the
-- second is guarded on `verdict IS NULL`.
