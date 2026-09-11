-- IMPLEMENTATION-SPEC §F.2 as amended 2026-09-02 (decision D9), implementing CV11 and AB6.
--
-- CV11: an aggregator relays, it does not translate. Two of the three things that requires had
-- nowhere to live. `schema_version` is the version of the DOCUMENT an entry was read from — the
-- envelope's version speaks only for the envelope (TRD §5.7 rule 3), so without this column every
-- relayed entry silently claimed ours. `verifier` is the identity block the peer published for
-- itself; the sync explicitly discarded it, and `verifier` in the served entry was rebuilt from the
-- TVL's `display_name`. That attribution stays (AU2 — it belongs to the party doing the trusting),
-- but the peer's own copy now travels beside it so a consumer can check one against the other.
ALTER TABLE "verification_result" ADD COLUMN "schema_version" TEXT;
ALTER TABLE "verification_result" ADD COLUMN "verifier" JSONB;

-- TRD §7.3's custody pair, which replaced the Registry API draft's single `out_of_band` boolean when
-- the published status object was cut over to the Results SEP shape.
ALTER TABLE "verification_result" ADD COLUMN "recipe_source" TEXT;
ALTER TABLE "verification_result" ADD COLUMN "image_trust_level" TEXT;

-- Plural, as the producer emits it. The singular column below predates that change.
ALTER TABLE "verification_result" ADD COLUMN "verified_source_code_uris" JSONB;

-- The two retired columns' values are folded into `recipe` BEFORE the drop, not after and not never.
--
-- `recipe` is a keep-everything-else bucket, not a whitelist: the sync stores every entry
-- field that has no column of its own there, and the read path spreads it back out verbatim. That is
-- exactly where a field we no longer emit belongs — a peer still publishing the draft's shape keeps
-- being relayed unchanged (CV8), through the general mechanism instead of a column of its own.
--
-- Doing it here rather than relying on the next sync tick is the difference between a derived table
-- and a table that is *currently* wrong. Both readings are defensible — the cache is rebuildable, so
-- a tick would restore these — but a window in which we serve an entry with a field silently missing
-- is a window in which we misreport a peer, and it costs two statements to not have one.
UPDATE "verification_result"
   SET "recipe" = COALESCE("recipe", '{}'::jsonb) || jsonb_build_object('out_of_band', "out_of_band")
 WHERE "out_of_band" IS NOT NULL;

UPDATE "verification_result"
   SET "recipe" = COALESCE("recipe", '{}'::jsonb)
                  || jsonb_build_object('verified_source_code_uri', "verified_source_code_uri")
 WHERE "verified_source_code_uri" IS NOT NULL;

ALTER TABLE "verification_result" DROP COLUMN "out_of_band";
ALTER TABLE "verification_result" DROP COLUMN "verified_source_code_uri";

-- AB6: a page names an unreachable verifier rather than omitting it, and `reason` has five values.
-- The sync stored only a message, so the read path could serve two of them — `not_yet_synced`, which
-- it derives from the scan cursor, and `fetch_failed` for everything else. A peer serving a malformed
-- document and a peer that is simply down therefore looked identical to a consumer, even though the
-- SDK's live fan-out over the same peers could already tell them apart.
ALTER TABLE "verifier_sync_cursor" ADD COLUMN "last_error_reason" TEXT;

-- Every retained row's served `verifier` block changes shape here: it was `{name: <our TVL label>}` and
-- becomes `{url: <the peer's result root>}`, because `verifier` is NULL for every pre-existing row and
-- the read path falls back to the root. That is a change to what `GET /v1/wasms` serves, and
-- `aggregated_wasm_index.entries_digest` is what tells a synchronised consumer a hash has changed.
--
-- Nothing else moves this clock for a stable contract: `reindex` runs only when a peer's entry is
-- recorded or withdrawn, so a hash whose verifiers publish nothing further would never reappear in the
-- stream and its consumers would hold the old shape indefinitely. The digest is computed in TypeScript
-- over the canonicalised entry set, so it cannot be recomputed here — emptying it guarantees the next
-- `reindex` sees a difference, and moving `aggregation_updated_at` re-delivers the corpus once, now,
-- which is the honest cost of having changed every entry at once.
UPDATE "aggregated_wasm_index" SET "aggregation_updated_at" = now(), "entries_digest" = '';
