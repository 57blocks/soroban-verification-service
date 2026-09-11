-- IMPLEMENTATION-SPEC §F.1's `completed_at`: when a job reached a terminal status. `updated_at` is
-- Prisma `@updatedAt` and keeps advancing on post-verdict writes (archive and source-publish
-- outcomes), so it never equalled the finish instant.
--
-- Existing rows are NOT backfilled: the only value to backfill from is that same drifted
-- `updated_at`, and once written it would be indistinguishable from a recorded one.

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "completed_at" TIMESTAMP(3);
