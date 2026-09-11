-- Closes the KNOWN GAP that `services/query-svc/src/common/tvl.ts` carried since this table was
-- created: the seeded `stellar-trusted-verifiers-list-v1` document has `display_name`, `trust_tier`
-- and a three-way `status`, the table had nowhere to put any of them, and the mapper invented
-- substitutes on read — `display_name` came back as the verifier id for every member, `trust_tier`
-- as undefined, and `paused` was unreachable however the document spelled it. IMPLEMENTATION-SPEC
-- §F.2 names all three columns.
--
-- `display_name` and `trust_tier` are nullable and land NULL on existing rows. That is not a data
-- loss window: the TVL seed is chained onto this migration inside the same ECS task
-- (.github/workflows/db-migrate.yml), so the values arrive from the committed document
-- moments later, and a row the document omits a name for reads back under its id exactly as before.
ALTER TABLE "trusted_verifiers" ADD COLUMN "display_name" TEXT;
ALTER TABLE "trusted_verifiers" ADD COLUMN "trust_tier" TEXT;

-- Added with a default so the NOT NULL holds for existing rows, then backfilled from the boolean it
-- replaces. Written before the DROP, deliberately: `enabled` is the only record of which members
-- were switched off, and dropping first would silently re-enable them.
ALTER TABLE "trusted_verifiers" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
UPDATE "trusted_verifiers" SET "status" = CASE WHEN "enabled" THEN 'active' ELSE 'disabled' END;

-- No 'paused' row can exist yet — two states cannot encode three. Members that should be paused are
-- 'active' after this backfill and become 'paused' on the next seed, from the document.
ALTER TABLE "trusted_verifiers" DROP COLUMN "enabled";
