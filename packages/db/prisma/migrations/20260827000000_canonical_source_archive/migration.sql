-- The canonical source archive.
--
-- `source_ref.source_sha256` is the hash of the bytes the submitter handed us. When those were a
-- container around the real source archive, or a tree an archive was rebuilt from, the archive this
-- rebuild actually built from is a different set of bytes — and it is that one whose hash SEP-58
-- means by `source_sha256` and which gets published.
--
-- All four columns are nullable with no backfill, and that is correct rather than lazy: NULL means
-- "the canonical archive is the submitted one", which is true of every row written before this
-- migration and of every ordinary submission after it. `canonical_source_sha256` is deliberately
-- left for the outcome path to compute from bytes it fetches itself rather than defaulted to
-- `source_ref.source_sha256` here — a value written by a migration would be indistinguishable from
-- one this service established, which is the substitution TB3 exists to prevent.
--
-- See docs/features/source-archive-canonicalisation/design.md §ACN-4/§ACN-6.
ALTER TABLE "rebuilds" ADD COLUMN     "canonical_source_key" TEXT,
ADD COLUMN     "canonical_source_sha256" TEXT,
ADD COLUMN     "chain_source_sha256" TEXT,
ADD COLUMN     "source_canonicalisation" JSONB;
