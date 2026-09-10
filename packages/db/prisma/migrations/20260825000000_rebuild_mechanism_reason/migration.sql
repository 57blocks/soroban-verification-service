-- PA1's routing reason, persisted on the rebuild rather than inferred at publish time
-- from JobRecord.verificationMode (a per-job "did the request carry a manifest" flag that a
-- console-prefilled cli-58 submission can set even when the recipe is, in fact, on-chain).
--
-- Backfilled conservatively for any pre-existing row: no such row has a real PA1 reason to read
-- (that machinery postdates them), so every existing row is set to `recipe_deviates_from_chain`
-- — the value `recipeSourceFor` maps to `submitted`, the answer that makes no unverifiable claim
-- about chain provenance, regardless of what `build_mode` that row happened to record.
--
-- See docs/features/report-artifact/decisions/recipe-source-derives-from-persisted-mechanism-reason.md
-- for the full reasoning, including a known, accepted caveat: republishing a job whose Rebuild row
-- predates this migration can now recompute a different recipe_source (and therefore a different
-- reports/<sha256>.json key) than that job's original publish. Confirmed at merge time (2026-08-25)
-- that no Rebuild row in dev or staging predates this migration.
ALTER TABLE "rebuilds" ADD COLUMN "mechanism_reason" TEXT;

UPDATE "rebuilds" SET "mechanism_reason" = 'recipe_deviates_from_chain' WHERE "mechanism_reason" IS NULL;

ALTER TABLE "rebuilds" ALTER COLUMN "mechanism_reason" SET NOT NULL;
