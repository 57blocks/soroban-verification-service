import { createHash } from "node:crypto";
import type { SourceReference } from "@scvs/core";
import { FetchPolicyError, UpstreamNotDeliveredError } from "@scvs/core/fetch-policy";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

/**
 * What the transport does under this policy — redirect re-validation, the resolved-address pin, the body cap —
 * is `policy-bound-fetch.spec.ts`'s subject and is not retested here.
 */
const STAGING = { bucket: "sv-test-scratch", region: "ap-southeast-2" };
const REBUILD = "rb-0001";

class TestService extends SourceResolutionService {
  readonly fetched: string[] = [];
  readonly staged: { key: string; bytes: number }[] = [];
  bodyBytes: Uint8Array = new Uint8Array([1, 2, 3]);
  failWith?: Error;

  protected override fetchUnderPolicy(uri: string): Promise<{ bytes: Uint8Array; finalUrl: string }> {
    this.fetched.push(uri);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({ bytes: this.bodyBytes, finalUrl: uri });
  }

  protected override putStagedObject(_s3: never, _bucket: string, key: string, bytes: Uint8Array) {
    this.staged.push({ key, bytes: bytes.byteLength });
    return Promise.resolve();
  }

  protected override presignUploadGet(_s3: never, bucket: string, key: string): Promise<string> {
    return Promise.resolve(`https://${bucket}.s3.amazonaws.com/${key}?X-Amz-Signature=sig&X-Amz-Credential=cred`);
  }
}

function service(): TestService {
  const configService = {
    get: (key: string) => (key === "stagingStorage" ? STAGING : undefined),
  } as unknown as ConstructorParameters<typeof SourceResolutionService>[0];
  const unusedRepo = {} as unknown as ConstructorParameters<typeof SourceResolutionService>[1];
  return new TestService(configService, unusedRepo, unusedRepo as never);
}

function sourceUriRef(uri: string | undefined, sha256: string): SourceReference {
  return { type: "source_uri", visibility: "public", source_uri: uri, source_sha256: sha256 } as SourceReference;
}

const BODY = new Uint8Array([1, 2, 3]);
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");

describe("resolveSourceRefForDispatch — shapes this verifier will not acquire", () => {
  it.each(["git", "hosted_tarball"] as const)("refuses a %s ref without requesting anything", async (type) => {
    const svc = service();

    const result = await svc.resolveSourceRefForDispatch(
      { type, visibility: "public", repo: "https://example.com/x.git", rev: "HEAD" } as SourceReference,
      REBUILD,
      "build",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_ref_unsupported");
    expect(svc.fetched).toEqual([]);
  });

  it("names a missing source_uri rather than reporting it as unreachable", async () => {
    const svc = service();

    const result = await svc.resolveSourceRefForDispatch(sourceUriRef(undefined, BODY_SHA256), REBUILD, "build");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_uri_missing");
    expect(svc.fetched).toEqual([]);
  });
});

describe("resolveSourceRefForDispatch — destinations refused before any request", () => {
  it.each([
    ["an http: URL", "http://example.com/source.tar.gz"],
    ["an RFC1918 literal", "https://10.0.0.1/source.tar.gz"],
    ["a loopback literal", "https://127.0.0.1/source.tar.gz"],
    ["the cloud metadata endpoint", "https://169.254.169.254/latest/meta-data/"],
    ["a bare local path, which SOURCE_URI_PATTERN still admits at submit", "/var/tmp/source.tar.gz"],
    ["a non-http scheme", "file:///etc/passwd"],
  ])("refuses %s, and never requests it", async (_label, uri) => {
    const svc = service();

    const result = await svc.resolveSourceRefForDispatch(sourceUriRef(uri, BODY_SHA256), REBUILD, "build");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_uri_refused");
      expect(result.detail).not.toBe("");
    }
    expect(svc.fetched).toEqual([]);
  });

  it("reports a policy refusal raised mid-fetch as a refusal, not as our own failure", async () => {
    const svc = service();
    svc.failWith = new FetchPolicyError("cdn.example.com resolves to 1 address(es) in a blocked range (10.1.2.3)");

    const result = await svc.resolveSourceRefForDispatch(
      sourceUriRef("https://cdn.example.com/source.tar.gz", BODY_SHA256),
      REBUILD,
      "build",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_uri_refused");
      expect(result.detail).toContain("blocked range");
    }
    expect(svc.staged).toEqual([]);
  });
});

/**
 * The other half of the same seam: `source_uri_refused` is what sends an operator to the egress policy, so only
 * a destination we would not go to may raise it.
 */
describe("resolveSourceRefForDispatch — a destination we admitted that delivered nothing", () => {
  it.each([
    ["a non-2xx from a reachable host", "Status 404 from https://raw.githubusercontent.com"],
    ["a timeout", "Timed out after 5000ms connecting to https://cdn.example.com"],
    ["a name with no address", "cdn.example.com resolved to no addresses"],
  ])("records %s as not materialized rather than refused", async (_label, message) => {
    const svc = service();
    svc.failWith = new UpstreamNotDeliveredError(message);

    const result = await svc.resolveSourceRefForDispatch(
      sourceUriRef("https://cdn.example.com/source.tar.gz", BODY_SHA256),
      REBUILD,
      "build",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_uri_not_materialized");
      expect(result.detail).toBe(message);
    }
    expect(svc.staged).toEqual([]);
  });
});

describe("resolveSourceRefForDispatch — what the builder is handed", () => {
  it("stages the bytes and replaces source_uri with a staging URL", async () => {
    const svc = service();
    svc.bodyBytes = BODY;

    const result = await svc.resolveSourceRefForDispatch(
      sourceUriRef("https://example.com/source.tar.gz", BODY_SHA256),
      REBUILD,
      "build",
    );

    expect(result.ok).toBe(true);
    expect(svc.fetched).toEqual(["https://example.com/source.tar.gz"]);
    expect(svc.staged).toEqual([{ key: `staging/${REBUILD}/build/fetched-source`, bytes: BODY.byteLength }]);
    if (result.ok) {
      // The submitter's host is gone from what crosses the boundary.
      expect(result.sourceRef.source_uri).toContain(`${STAGING.bucket}.s3.amazonaws.com`);
      expect(result.sourceRef.source_uri).not.toContain("example.com/source.tar.gz");
    }
  });

  it("keys the staged object per mode, so a redispatch cannot read the other attempt's bytes", async () => {
    const svc = service();

    await svc.resolveSourceRefForDispatch(sourceUriRef("https://example.com/s.tgz", BODY_SHA256), REBUILD, "build");
    await svc.resolveSourceRefForDispatch(sourceUriRef("https://example.com/s.tgz", BODY_SHA256), REBUILD, "verify");

    expect(svc.staged.map((s) => s.key)).toEqual([
      `staging/${REBUILD}/build/fetched-source`,
      `staging/${REBUILD}/verify/fetched-source`,
    ]);
  });

  it("refuses bytes that do not hash to the submitted source_sha256, and stages nothing", async () => {
    const svc = service();
    svc.bodyBytes = BODY;

    const result = await svc.resolveSourceRefForDispatch(
      sourceUriRef("https://example.com/source.tar.gz", "b".repeat(64)),
      REBUILD,
      "build",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_hash_mismatch");
    // The point of catching it here rather than in the sandbox: no Batch job is spent on it.
    expect(svc.staged).toEqual([]);
  });

  it("accepts an upper-cased submitted hash, matching the sandbox's own comparison", async () => {
    const svc = service();
    svc.bodyBytes = BODY;

    const result = await svc.resolveSourceRefForDispatch(
      sourceUriRef("https://example.com/source.tar.gz", BODY_SHA256.toUpperCase()),
      REBUILD,
      "build",
    );

    expect(result.ok).toBe(true);
  });
});
