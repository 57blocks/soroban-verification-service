-- TrustedVerifier/VerificationResult/VerifierSyncCursor/AggregatedWasmIndex moved to
-- @scvs/db-query, which owns their schema and migration history going forward (see
-- docs/features/read-and-aggregate/plan-query-svc-own-rds.md). Phase 2 removed these models from
-- this package's schema.prisma but deliberately left the physical tables and the migrations that
-- created them (20260806072758_read_and_aggregate_tables, 20260806080519_trusted_verifier_bulk_load_url)
-- untouched, so the shared stellar-dev-postgres instance kept working unmodified during the cutover.
--
-- This migration is that phase 8 cleanup, moved earlier than planned: a brand-new empty database
-- (CI, a fresh local clone) applies every migration in this package's history in order, so those two
-- old migrations still recreate these four tables here — and @scvs/db-query's own migration then
-- collides trying to create the same table names on what CI intends as a SEPARATE database.
-- Dropping them here is safe: nothing in @scvs/db's code has referenced any of these four models
-- since Phase 2 (confirmed by grep), and this package's own migration history is the only place
-- that still declared them.
--
-- Not a rename, not a data migration — the equivalent data (none, in a fresh database; the existing
-- rows are on stellar-dev-postgres in an already-cutover deployment, dropped separately once the
-- cutover is verified stable there) lives in @scvs/db-query's own table of the same name, on
-- query-svc's own, independent instance.
DROP TABLE IF EXISTS "verification_result";
DROP TABLE IF EXISTS "verifier_sync_cursor";
DROP TABLE IF EXISTS "aggregated_wasm_index";
DROP TABLE IF EXISTS "trusted_verifiers";
