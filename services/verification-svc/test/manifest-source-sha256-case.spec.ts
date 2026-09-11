import { RegistryStatusObject, SEP58_HEX_SHA256, parseDto } from "@scvs/core";
import { validateSubmittedManifest } from "../src/modules/preflight/manifest.js";
import type { VerificationTarget } from "@scvs/core";

/** `manifest.source_sha256` at the submit boundary. */
const TARGET: VerificationTarget = {
  network: "testnet",
  wasm_hash: "8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c",
};

const UPPERCASE = "28A14827FA2B0E45D0A66E1E4C4A57A6F0E1F1B92BD9C4D5E6F708192A3B4C5D";
const LOWERCASE = UPPERCASE.toLowerCase();

const submit = (source_sha256: unknown) =>
  validateSubmittedManifest(
    {
      schema: "stellar-submitted-source-verification-manifest-v1",
      source_uri: "https://example.test/source.tar.gz",
      ...(source_sha256 === undefined ? {} : { source_sha256 }),
    },
    TARGET,
  );

const accepted = (source_sha256: unknown): string => {
  const result = submit(source_sha256);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(source_sha256)} to be accepted: ${result.detail}`);
  return result.manifest.source_sha256;
};

const rejectionFor = (source_sha256: unknown): string => {
  const result = submit(source_sha256);
  if (result.ok) throw new Error(`expected ${JSON.stringify(source_sha256)} to be rejected`);
  expect(result.error).toBe("invalid_manifest");
  return result.detail;
};

/** The published document, as `publish.service.ts` assembles it from the row this manifest becomes. */
const publishWith = (sourceSha256: string) =>
  parseDto(RegistryStatusObject, {
    schema: "stellar-verification-status",
    schema_version: "1.0",
    wasm_hash: TARGET.wasm_hash,
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
  });

describe("manifest.source_sha256 at the submit boundary", () => {
  it("accepts an uppercase value and normalises it", () => {
    expect(accepted(UPPERCASE)).toBe(LOWERCASE);
  });

  it("normalises a mixed-case paste too — the realistic shape, not all-caps", () => {
    expect(accepted(`${UPPERCASE.slice(0, 32)}${LOWERCASE.slice(32)}`)).toBe(LOWERCASE);
  });

  it("leaves an already-lowercase value alone", () => {
    expect(accepted(LOWERCASE)).toBe(LOWERCASE);
  });

  it("still refuses a value that is not a 64-character hex digest", () => {
    const message = "manifest.source_sha256 is required and must be a 64-character hex string (SEP-58 §2).";
    expect(rejectionFor(LOWERCASE.slice(0, 63))).toBe(message);
    expect(rejectionFor(`${"z".repeat(2)}${LOWERCASE.slice(2)}`)).toBe(message);
    expect(rejectionFor(`0x${LOWERCASE}`)).toBe(message);
    expect(rejectionFor(undefined)).toBe(message);
  });

  it("stops claiming a lowercase rule it does not enforce", () => {
    // The message said "must be a 64-character lowercase hex string" while the regex carried `/i`, which is how
    // a submitter reading the refusal could not learn what actually happens.
    expect(rejectionFor("not-a-hash")).not.toContain("lowercase");
  });
});

describe("what submit accepts must be publishable", () => {
  // The assertion whose absence is what makes this defect class recur.
  it("hands the publish validator a value it accepts", () => {
    const normalised = accepted(UPPERCASE);
    expect(SEP58_HEX_SHA256.test(normalised)).toBe(true);
    expect(() => publishWith(normalised)).not.toThrow();
  });

  it("and the publish validator still refuses uppercase itself", () => {
    // Normalising is the input boundary's job, not the publish boundary's.
    expect(() => publishWith(UPPERCASE)).toThrow();
  });
});
