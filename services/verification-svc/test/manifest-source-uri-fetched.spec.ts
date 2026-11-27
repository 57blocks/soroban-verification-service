import { unfetchableChainSourceUri, validateSubmittedManifest } from "../src/modules/preflight/manifest.js";
import type { VerificationTarget } from "@scvs/core";

const TARGET: VerificationTarget = { network: "testnet", wasm_hash: "8".repeat(64) };
const UPLOAD_ID = "3f2c1a9e-5b7d-4c8e-9a1f-0d2e4b6c8a10";

const submit = (source: { source_uri?: string; upload_id?: string }) =>
  validateSubmittedManifest(
    { schema: "stellar-submitted-source-verification-manifest-v1", source_sha256: "a".repeat(64), is_public: true, ...source },
    TARGET,
  );

describe("a published source_uri is one the verifier fetched", () => {
  it("refuses a source_uri beside an upload_id, which is built without fetching it", () => {
    const result = submit({ source_uri: "https://example.com/src.tar.gz", upload_id: UPLOAD_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_manifest");
      expect(result.detail).toContain("both source_uri and upload_id");
    }
  });

  it.each([
    ["a javascript: URI", "javascript:alert(1)"],
    ["a data: URI", "data:text/html,<script>alert(1)</script>"],
    ["a file: URI", "file:///etc/passwd"],
    ["a bare local path", "/var/tmp/source.tar.gz"],
    ["an http: URL", "http://example.com/src.tar.gz"],
    ["a scheme-relative spelling", "https:example.com/src.tar.gz"],
    ["a single-slash spelling", "https:/example.com/src.tar.gz"],
    ["a backslash, which parsers read differently", "https://example.com\\@evil.example/src.tar.gz"],
    ["no host", "https:///src.tar.gz"],
  ])("refuses %s as a source_uri", (_label, uri) => {
    const result = submit({ source_uri: uri });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_manifest");
      expect(result.detail).toContain("https://");
    }
  });

  it("accepts an https URL alone, and an upload alone", () => {
    expect(submit({ source_uri: "https://example.com/src.tar.gz" }).ok).toBe(true);
    expect(submit({ upload_id: UPLOAD_ID }).ok).toBe(true);
  });
});

describe("a job is created from chain metadata alone only when the recorded source_uri can be fetched", () => {
  it.each(["ipfs://bafy/source.tar.gz", "http://example.com/src.tar.gz", "javascript:alert(1)", undefined])(
    "refuses a recorded %s",
    (uri) => {
      expect(unfetchableChainSourceUri(uri)).toContain("https://");
    },
  );

  it("admits a recorded https URL", () => {
    expect(unfetchableChainSourceUri("https://example.com/src.tar.gz")).toBeUndefined();
  });
});
