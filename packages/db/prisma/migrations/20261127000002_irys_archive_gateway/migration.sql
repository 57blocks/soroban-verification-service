-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "archived_gateway_url" TEXT,
ADD COLUMN "source_archived_gateway_url" TEXT;

-- Every id archived so far is an Irys upload, served by Irys's gateway rather than the one now configured.
UPDATE "jobs" SET "archived_gateway_url" = 'https://gateway.irys.xyz' WHERE "archived_tx_id" IS NOT NULL;
UPDATE "jobs" SET "source_archived_gateway_url" = 'https://gateway.irys.xyz' WHERE "source_archived_tx_id" IS NOT NULL;
