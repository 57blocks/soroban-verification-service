-- Every claim row so far records an Irys upload. Its tx_id is not an Arweave id on the gateways the archive now links
-- to, so a later job with the same content would be linked to a copy that is not there. Forgetting the rows makes that
-- content upload again through Turbo; links already written to status objects are left as they are.
DELETE FROM "report_archive_uploads";
DELETE FROM "source_archive_uploads";
