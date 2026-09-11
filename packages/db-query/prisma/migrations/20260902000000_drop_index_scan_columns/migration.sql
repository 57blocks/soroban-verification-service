-- AlterTable
-- See docs/features/read-and-aggregate/decisions/static-only-tvl-membership-is-foreclosed-again.md.
ALTER TABLE "verifier_sync_cursor" DROP COLUMN "first_cycle_completed_at",
DROP COLUMN "index_cursor";
