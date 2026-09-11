-- TRD §4.3's job lifecycle. No schema change: `jobs.status` is plain `text` with no database-level
-- enum, so this migration only moves values.
--
-- ★ It ships in the same commit as the widened `jobStatuses`, and must never land ahead of it.
-- `packages/db`'s `rowToJob` runs `assertJobStatus`, which THROWS on an unrecognised value — so a
-- row written to `preparing` or `publish_pending` while the deployed enum still lacks them takes out
-- `listJobsByStatus`, the orchestrator health controller and `GET /v1/jobs/:id` for that row.
--
-- Two of the existing values are re-pointed rather than added to, because the old names were off by
-- one against §4.3: `building` was written before image policy and the chain lookup (which is
-- `preparing`), and `comparing` covered everything from attaching to a rebuild through to
-- publication (which is `building`, `comparing`, `publishing` and `publish_pending`).

-- 1. Pre-attach work is `preparing`.
UPDATE "jobs" SET "status" = 'preparing' WHERE "status" = 'building';

-- 2. A verdict that was computed but not published is `publish_pending` — this is exactly the
--    population the publish-recovery scan used to select as "comparing and happens to hold a
--    result". Runs BEFORE step 3, or every one of these rows collapses into `building` first.
UPDATE "jobs"
   SET "status" = 'publish_pending'
 WHERE "status" = 'comparing' AND "result_summary" IS NOT NULL;

-- 3. Everything still `comparing` was waiting on its rebuild, which is `building`.
UPDATE "jobs" SET "status" = 'building' WHERE "status" = 'comparing';

-- 4. Those publish_pending rows already hold a computed verdict; carry it into the column that now
--    records it, from the comparison's own `matched` rather than from `status_summary` (which is
--    still the interim value at that point in the pipeline).
UPDATE "jobs"
   SET "verdict" = CASE WHEN "result_summary"->>'matched' = 'true' THEN 'verified' ELSE 'mismatched' END
 WHERE "status" = 'publish_pending'
   AND "verdict" IS NULL
   AND "result_summary"->>'matched' IS NOT NULL;

-- 5. `deduped` is not in §4.3 and nothing has written it since the ADR-008 split removed the path.
--    The expected count is zero — confirmed locally, docs/features/dedup-and-lifecycle/notes.md's
--    Phase 0 entry. If a deployed database does have such rows they are pre-split submissions that
--    were answered with ANOTHER job's row and hold no verdict of their own, so they become a failure
--    with a greppable code rather than a claim about a verification that never ran for them.
UPDATE "jobs"
   SET "status" = 'failed',
       "failure_reason" = 'internal_error',
       "error_code" = 'legacy_deduped'
 WHERE "status" = 'deduped';
