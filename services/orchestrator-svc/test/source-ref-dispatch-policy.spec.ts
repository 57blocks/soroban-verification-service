import { createHash } from "node:crypto";
import type { SourceReference } from "@scvs/core";
import { FetchPolicyError, UpstreamNotDeliveredError } from "@scvs/core/fetch-policy";
import { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

const STAGING = { bucket: "sv-test-scratch", region: "ap-southeast-2" };
const REBUILD = "rb-0001";
const JOB = "0b0b0b0b-1111-2222-3333-444444444444";
const OWN_COPY = `staging/jobs/${JOB}/source`;

class TestService extends SourceResolutionService {
  readonly fetched: string[] = [];
  readonly staged: { key: string; bytes: number }[] = [];
  readonly objects = new Map<string, Uint8Array>();
  bodyBytes: Uint8Array = new Uint8Array([1, 2, 3]);
  failWith?: Error;

  protected override fetchUnderPolicy(uri: string): Promise<{ bytes: Uint8Array; finalUrl: string }> {
    this.fetched.push(uri);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({ bytes: this.bodyBytes, finalUrl: uri });
  }

  protected override putStagedObject(_s3: never, _bucket: string, key: string, bytes: Uint8Array) {
    this.staged.push({ key, bytes: bytes.byteLength });
    this.objects.set(key, bytes);
    return Promise.resolve();
  }

  protected override stagedObjectExists(_s3: never, _bucket: string, key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  override readStagingObjectBytes(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.objects.get(key));
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
      JOB,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_ref_unsupported");
    expect(svc.fetched).toEqual([]);
  });

  it("names a missing source_uri rather than reporting it as unreachable", async () => {
    const svc = service();

    const result = await svc.resolveSourceRefForDispatch(sourceUriRef(undefined, BODY_SHA256), REBUILD, "build", JOB);

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

    const result = await svc.resolveSourceRefForDispatch(sourceUriRef(uri, BODY_SHA256), REBUILD, "build", JOB);

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
      JOB,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_uri_refused");
      expect(result.detail).toContain("blocked range");
    }
    expect(svc.staged).toEqual([]);
  });
});

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
      JOB,
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
      JOB,
    );

    expect(result.ok).toBe(true);
    expect(svc.fetched).toEqual(["https://example.com/source.tar.gz"]);
    expect(svc.staged).toEqual([
      { key: OWN_COPY, bytes: BODY.byteLength },
      { key: `staging/${REBUILD}/build/fetched-source`, bytes: BODY.byteLength },
    ]);
    if (result.ok) {
      expect(result.sourceRef.source_uri).toContain(`${STAGING.bucket}.s3.amazonaws.com`);
      expect(result.sourceRef.source_uri).not.toContain("example.com/source.tar.gz");
    }
  });

  it("keys the staged object per mode, so a redispatch cannot read the other attempt's bytes", async () => {
    const svc = service();

    await svc.resolveSourceRefForDispatch(sourceUriRef("https://example.com/s.tgz", BODY_SHA256), REBUILD, "build", JOB);
    await svc.resolveSourceRefForDispatch(sourceUriRef("https://example.com/s.tgz", BODY_SHA256), REBUILD, "verify", JOB);

    expect(svc.staged.map((s) => s.key)).toEqual([
      OWN_COPY,
      `staging/${REBUILD}/build/fetched-source`,
      `staging/${REBUILD}/verify/fetched-source`,
    ]);
    expect(svc.fetched).toHaveLength(1);
  });

  it("refuses bytes that do not hash to the submitted source_sha256, and stages nothing", async () => {
    const svc = service();
    svc.bodyBytes = BODY;

    const result = await svc.resolveSourceRefForDispatch(
      sourceUriRef("https://example.com/source.tar.gz", "b".repeat(64)),
      REBUILD,
      "build",
      JOB,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_hash_mismatch");
    expect(svc.staged).toEqual([]);
  });

  it("accepts an upper-cased submitted hash, matching the sandbox's own comparison", async () => {
    const svc = service();
    svc.bodyBytes = BODY;

    const result = await svc.resolveSourceRefForDispatch(
      sourceUriRef("https://example.com/source.tar.gz", BODY_SHA256.toUpperCase()),
      REBUILD,
      "build",
      JOB,
    );

    expect(result.ok).toBe(true);
  });
});

describe("proveSourcePossession — a job holds what it declares before it may share a rebuild", () => {
  it("fetches the job's own URL, checks the hash, and keeps the bytes under the job's own key", async () => {
    const svc = service();
    svc.bodyBytes = BODY;

    const result = await svc.proveSourcePossession(sourceUriRef("https://example.com/source.tar.gz", BODY_SHA256), JOB);

    expect(result).toEqual({ ok: true });
    expect(svc.fetched).toEqual(["https://example.com/source.tar.gz"]);
    expect(svc.staged).toEqual([{ key: OWN_COPY, bytes: BODY.byteLength }]);
  });

  it("refuses a URL that never serves the declared bytes, and keeps nothing", async () => {
    const svc = service();
    svc.failWith = new UpstreamNotDeliveredError("Status 404 from https://attacker.invalid");

    const result = await svc.proveSourcePossession(sourceUriRef("https://attacker.invalid/never-served.tar.gz", BODY_SHA256), JOB);

    expect(result).toMatchObject({ ok: false, reason: "source_uri_not_materialized" });
    expect(svc.staged).toEqual([]);
  });

  it("refuses bytes that hash to something other than the declared source_sha256", async () => {
    const svc = service();
    svc.bodyBytes = new Uint8Array([9, 9, 9]);

    const result = await svc.proveSourcePossession(sourceUriRef("https://example.com/source.tar.gz", BODY_SHA256), JOB);

    expect(result).toMatchObject({ ok: false, reason: "source_hash_mismatch" });
    expect(svc.staged).toEqual([]);
  });

  it("does not fetch again once the job's own copy exists", async () => {
    const svc = service();
    svc.objects.set(OWN_COPY, BODY);

    expect(await svc.proveSourcePossession(sourceUriRef("https://example.com/source.tar.gz", BODY_SHA256), JOB)).toEqual({ ok: true });
    expect(svc.fetched).toEqual([]);
  });

  it("builds from the job's own copy without requesting the URL a second time", async () => {
    const svc = service();
    svc.objects.set(OWN_COPY, BODY);
    svc.failWith = new Error("the submitter URL must not be requested again");

    const result = await svc.resolveSourceRefForDispatch(sourceUriRef("https://example.com/source.tar.gz", BODY_SHA256), REBUILD, "build", JOB);

    expect(result.ok).toBe(true);
    expect(svc.fetched).toEqual([]);
    expect(svc.staged).toEqual([{ key: `staging/${REBUILD}/build/fetched-source`, bytes: BODY.byteLength }]);
  });

  it("asks nothing of an uploaded source, whose hash was checked when it was received", async () => {
    const svc = service();

    const result = await svc.proveSourcePossession(
      { type: "private_tarball", visibility: "private", tarball_sha256: BODY_SHA256, upload_id: JOB } as SourceReference,
      JOB,
    );

    expect(result).toEqual({ ok: true });
    expect(svc.fetched).toEqual([]);
  });

  it.each(["git", "hosted_tarball"] as const)("lets no %s ref share a rebuild, as none is ever dispatched", async (type) => {
    const svc = service();

    const result = await svc.proveSourcePossession(
      { type, visibility: "public", repo: "https://example.com/x.git", rev: "HEAD" } as SourceReference,
      JOB,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source_ref_unsupported");
    expect(svc.fetched).toEqual([]);
  });
});
