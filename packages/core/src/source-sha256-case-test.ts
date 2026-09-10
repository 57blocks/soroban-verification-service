import assert from "node:assert/strict";
// Before any module whose decorators run at class-definition time — `batch-test.ts`'s precedent.
import "reflect-metadata";
import { computeIdempotencyKey } from "./rebuild-key.js";
import { RegistryStatusObject, SEP58_HEX_SHA256 } from "./registry.js";
import { parseSourceReference, SubmittedSourceManifest, type SourceReference } from "./source.js";
import { parseDto } from "./validate.js";

const UPPERCASE = "28A14827FA2B0E45D0A66E1E4C4A57A6F0E1F1B92BD9C4D5E6F708192A3B4C5D";
const LOWERCASE = UPPERCASE.toLowerCase();
const MIXED = `${UPPERCASE.slice(0, 32)}${LOWERCASE.slice(32)}`;

const IMAGE_DIGEST = "docker.io/stellar/stellar-cli@sha256:" + "b".repeat(64);

/** `parseSourceReference` returns the union; the variant-specific digests need it narrowed. */
function parseRef<T extends SourceReference["type"]>(
  type: T,
  fields: Record<string, unknown>,
): Extract<SourceReference, { type: T }> {
  const ref = parseSourceReference({ type, ...fields });
  assert.equal(ref.type, type);
  return ref as Extract<SourceReference, { type: T }>;
}

function statusObject(sourceSha256: string): unknown {
  return {
    schema: "stellar-verification-status",
    schema_version: "1.0",
    wasm_hash: "8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c",
    updated_at: "2026-09-02T00:00:00Z",
    source_code_verifications: [
      {
        verifier: { url: "https://v.example/public/", name: "scvs" },
        status: "verified",
        recipe_source: "on_chain_metadata",
        image_trust_level: "sdf_trusted",
        processed_at: "2026-09-02T00:00:00Z",
        source_sha256: sourceSha256,
      },
    ],
  };
}

function main(): void {
  // ---- the row-read path, per variant -------------------------------------------------------
  // `jobs.repo.ts` and `rebuilds.repo.ts` parse every stored `sourceRef` column through `parseSourceReference`,
  // so this is what makes a row written before the submit gate closed publishable with no migration.
  const uri = parseSourceReference({
    type: "source_uri",
    visibility: "private",
    source_uri: "https://example.test/source.tar.gz",
    source_sha256: UPPERCASE,
  });
  assert.equal(uri.source_sha256, LOWERCASE, "source_uri.source_sha256 must normalise on parse");

  const priv = parseRef("private_tarball", {
    visibility: "private",
    tarball_sha256: UPPERCASE,
    source_sha256: MIXED,
    upload_id: "3f6ca0d2-6c2f-4a3b-9d1e-0f5a7c8b9d10",
  });
  assert.equal(priv.tarball_sha256, LOWERCASE, "private_tarball.tarball_sha256 must normalise");
  assert.equal(priv.source_sha256, LOWERCASE, "a mixed-case paste is the realistic one, not all-caps");

  const hosted = parseRef("hosted_tarball", {
    visibility: "public",
    tarball_url: "https://example.test/source.tar.gz",
    tarball_sha256: UPPERCASE,
  });
  assert.equal(hosted.tarball_sha256, LOWERCASE);
  assert.equal(hosted.source_sha256, undefined, "@LowercaseHex must not turn an absent field into a string");

  const git = parseSourceReference({
    type: "git",
    visibility: "public",
    repo: "https://example.test/repo.git",
    rev: "c".repeat(40),
    source_sha256: UPPERCASE,
  });
  assert.equal(git.source_sha256, LOWERCASE);

  // Already-lowercase input is untouched, and a genuine stored row (JSON, not a literal) round-trips.
  assert.equal(
    parseSourceReference({ type: "source_uri", visibility: "public", source_sha256: LOWERCASE }).source_sha256,
    LOWERCASE,
  );
  const fromStoredRow = parseSourceReference(
    JSON.parse(`{"type":"source_uri","visibility":"private","source_sha256":"${UPPERCASE}"}`),
  );
  assert.equal(fromStoredRow.source_sha256, LOWERCASE);

  // The stored `manifest` column is read back through this class (`jobs.repo.ts`), so it needs the same
  // treatment — the submitted manifest is published evidence of what was asked for.
  const manifest = parseDto(SubmittedSourceManifest, {
    schema: "stellar-submitted-source-verification-manifest-v1",
    target: { network: "testnet", wasm_hash: "a".repeat(64) },
    source_sha256: UPPERCASE,
    source_uri: "https://example.test/source.tar.gz",
  });
  assert.equal(manifest.source_sha256, LOWERCASE);

  // ---- K1: one set of bytes, one rebuild key ------------------------------------------------
  // The only behaviour change this ruling introduces, and the reason it was the owner's to make.
  const keyFromUppercase = computeIdempotencyKey(uri, IMAGE_DIGEST, { bldarg: [], bldopt: [] });
  const keyFromLowercase = computeIdempotencyKey(
    parseSourceReference({
      type: "source_uri",
      visibility: "private",
      source_uri: "https://example.test/source.tar.gz",
      source_sha256: LOWERCASE,
    }),
    IMAGE_DIGEST,
    { bldarg: [], bldopt: [] },
  );
  assert.equal(
    keyFromUppercase,
    keyFromLowercase,
    "two spellings of one hash describe the same bytes and must share one rebuild — §E K1",
  );

  assert.notEqual(
    computeIdempotencyKey(
      { type: "source_uri", visibility: "private", source_sha256: UPPERCASE } as never,
      IMAGE_DIGEST,
      { bldarg: [], bldopt: [] },
    ),
    keyFromLowercase,
    "the key is a hash of the string it is handed — which is why the normalisation has to happen before it",
  );

  // ---- the two boundaries agree on ONE rule --------------------------------------------------
  // The assertion whose absence is what makes this defect class recur: anything the input boundary accepts must
  // be publishable, and the constant is shared rather than copied.
  assert.equal(SEP58_HEX_SHA256.test(uri.source_sha256 as string), true);
  parseDto(RegistryStatusObject, statusObject(uri.source_sha256 as string));
  assert.throws(
    () => parseDto(RegistryStatusObject, statusObject(UPPERCASE)),
    "the publish validator must still refuse uppercase — normalising is the boundary's job, not its own",
  );

  console.log("source_sha256: case normalised on parse, one rebuild key per bytes, agreed with the publish validator");
}

main();
