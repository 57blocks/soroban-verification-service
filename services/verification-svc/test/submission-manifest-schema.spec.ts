import type { VerificationTarget } from "@scvs/core";
import { validateSubmittedManifest } from "../src/modules/preflight/manifest.js";
import { SubmissionManifest } from "../src/modules/verifications/submit.dto.js";

const TARGET: VerificationTarget = {
  network: "testnet",
  wasm_hash: "8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c",
};

const SAMPLE: Record<string, unknown> = {
  schema: "stellar-submitted-source-verification-manifest-v1",
  source_sha256: "a".repeat(64),
  source_uri: "https://example.test/source.tar.gz",
  upload_id: "0f8b9c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
  is_public: true,
  bldopt: ["--package=token"],
  bldarg: ["--locked"],
  bldimg: `docker.io/stellar/stellar-cli@sha256:${"b".repeat(64)}`,
};

const documented = (Reflect.getMetadata("swagger/apiModelPropertiesArray", SubmissionManifest.prototype) as string[]).map(
  (key) => key.replace(/^:/, ""),
);
const isRequired = (key: string) =>
  (Reflect.getMetadata("swagger/apiModelProperties", SubmissionManifest.prototype, key) as { required?: boolean })
    .required !== false;
const required = documented.filter(isRequired);
const pick = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, SAMPLE[key]]));

describe("the documented submission manifest matches what submit accepts", () => {
  it("documents a sample for every property", () => {
    expect(documented.filter((key) => !(key in SAMPLE))).toEqual([]);
  });

  it("requires schema and source_sha256, and nothing else", () => {
    expect(required.sort()).toEqual(["schema", "source_sha256"]);
  });

  it("accepts every documented property at once", () => {
    expect(validateSubmittedManifest(pick(documented), TARGET).ok).toBe(true);
  });

  it("accepts the required properties plus either source", () => {
    expect(validateSubmittedManifest(pick([...required, "source_uri"]), TARGET).ok).toBe(true);
    expect(validateSubmittedManifest(pick([...required, "upload_id"]), TARGET).ok).toBe(true);
  });

  it("rejects a manifest missing any required property", () => {
    for (const missing of required) {
      const result = validateSubmittedManifest(pick([...required.filter((key) => key !== missing), "source_uri"]), TARGET);
      expect({ missing, ok: result.ok }).toEqual({ missing, ok: false });
    }
  });

  it("rejects a manifest that names neither source", () => {
    expect(validateSubmittedManifest(pick(required), TARGET).ok).toBe(false);
  });
});
