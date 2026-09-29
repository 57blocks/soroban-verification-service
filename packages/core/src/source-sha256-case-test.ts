import assert from "node:assert/strict";
// Must load before any decorated class is evaluated.
import "reflect-metadata";
import { computeIdempotencyKey } from "./rebuild-key.js";
import { RegistryStatusObject, SEP58_HEX_SHA256 } from "./registry.js";
import { parseSourceReference, SubmittedSourceManifest, type SourceReference } from "./source.js";
import { parseDto } from "./validate.js";

const UPPERCASE = "28A14827FA2B0E45D0A66E1E4C4A57A6F0E1F1B92BD9C4D5E6F708192A3B4C5D";
const LOWERCASE = UPPERCASE.toLowerCase();
const MIXED = `${UPPERCASE.slice(0, 32)}${LOWERCASE.slice(32)}`;

const IMAGE_DIGEST = "docker.io/stellar/stellar-cli@sha256:" + "b".repeat(64);

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
        image_trust_level: "official_trusted",
        processed_at: "2026-09-02T00:00:00Z",
        source_sha256: sourceSha256,
      },
    ],
  };
}

function main(): void {
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

  assert.equal(
    parseSourceReference({ type: "source_uri", visibility: "public", source_sha256: LOWERCASE }).source_sha256,
    LOWERCASE,
  );
  const fromStoredRow = parseSourceReference(
    JSON.parse(`{"type":"source_uri","visibility":"private","source_sha256":"${UPPERCASE}"}`),
  );
  assert.equal(fromStoredRow.source_sha256, LOWERCASE);

  const manifest = parseDto(SubmittedSourceManifest, {
    schema: "stellar-submitted-source-verification-manifest-v1",
    target: { network: "testnet", wasm_hash: "a".repeat(64) },
    source_sha256: UPPERCASE,
    source_uri: "https://example.test/source.tar.gz",
  });
  assert.equal(manifest.source_sha256, LOWERCASE);

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

  assert.equal(SEP58_HEX_SHA256.test(uri.source_sha256 as string), true);
  parseDto(RegistryStatusObject, statusObject(uri.source_sha256 as string));
  assert.throws(
    () => parseDto(RegistryStatusObject, statusObject(UPPERCASE)),
    "the publish validator must still refuse uppercase — normalising is the boundary's job, not its own",
  );

  console.log("source_sha256: case normalised on parse, one rebuild key per bytes, agreed with the publish validator");
}

main();
