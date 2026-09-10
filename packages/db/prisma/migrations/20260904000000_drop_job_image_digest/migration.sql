-- `jobs.image_digest` has had no reader since an earlier change deleted the one `!rebuild`
-- compatibility branch that read it, and no writer since `cef5154a` (2026-08-07) stopped
-- `createJob` from setting it. It was NOT always null, though: from the table's first migration
-- (2026-07-20) until cef5154a, every submission wrote `manifest.bldimg` into it. The guard below
-- turns "silently drop a value nobody expected" into "fail loudly and go look," in case any row
-- from that 18-day window still exists.
--
-- Hand-authored rather than `prisma migrate dev --create-only`: the local shadow-database diff
-- also picks up unrelated drift from `packages/db-query`'s tables sharing this Postgres instance.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "jobs" WHERE "image_digest" IS NOT NULL) THEN
    RAISE EXCEPTION 'jobs.image_digest has non-null rows (created 2026-07-20..2026-08-07, before cef5154a stopped writing it) — investigate before dropping the column; this migration assumed none survive';
  END IF;
END $$;

ALTER TABLE "jobs" DROP COLUMN "image_digest";
