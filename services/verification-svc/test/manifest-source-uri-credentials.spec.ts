import { validateSubmittedManifest } from "../src/modules/preflight/manifest.js";
import type { VerificationTarget } from "@scvs/core";

const TARGET: VerificationTarget = { network: "testnet", wasm_hash: "8".repeat(64) };

const submit = (source_uri: string, is_public: boolean) =>
  validateSubmittedManifest(
    { schema: "stellar-submitted-source-verification-manifest-v1", source_sha256: "a".repeat(64), source_uri, is_public },
    TARGET,
  );

describe("a public submission's source_uri is published, so it may carry no credentials", () => {
  it.each([
    ["a presigned S3 URL", "https://bucket.s3.amazonaws.com/src.tar.gz?X-Amz-Signature=abc&X-Amz-Credential=x"],
    ["a user and password", "https://user:pass@example.com/src.tar.gz"],
    ["an access token", "https://example.com/src.tar.gz?access_token=abc"],
  ])("refuses %s when is_public is true", (_label, uri) => {
    const result = submit(uri, true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_manifest");
      expect(result.detail).toContain("is_public: false");
    }
  });

  it("accepts the same URL for a private submission, which no longer publishes it", () => {
    expect(submit("https://bucket.s3.amazonaws.com/src.tar.gz?X-Amz-Signature=abc", false).ok).toBe(true);
  });

  it("accepts an ordinary public URL", () => {
    expect(submit("https://github.com/o/r/archive/v1.tar.gz?ref=main", true).ok).toBe(true);
  });
});
