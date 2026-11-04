import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SourceReference } from "@scvs/core";
import { sourceSha256FromFileName } from "@scvs/storage-layout";
import {
  canonicalArchiveExtension,
  declareSourceFileName,
  deriveExtension,
  readSourceBytesForPublishing,
} from "../src/modules/source-resolution/publish-source-bytes.util.js";
import type { SourceResolutionService } from "../src/modules/source-resolution/source-resolution.service.js";

describe("deriveExtension", () => {
  it("treats .tar.gz as one unit, not the last .-segment", () => {
    expect(deriveExtension("myproject.tar.gz")).toBe(".tar.gz");
  });

  it("treats .tar.bz2 as one unit", () => {
    expect(deriveExtension("myproject.tar.bz2")).toBe(".tar.bz2");
  });

  it("extracts a plain extension from a filename", () => {
    expect(deriveExtension("myproject.zip")).toBe(".zip");
  });

  it("extracts the extension from a URL's path, ignoring query/fragment", () => {
    expect(deriveExtension("https://example.com/archives/myproject.tar.gz?token=abc#x")).toBe(".tar.gz");
  });

  it("extracts a plain extension from a URL", () => {
    expect(deriveExtension("https://example.com/archives/myproject.zip")).toBe(".zip");
  });

  it("falls back to .tar.gz for a filename with no extension", () => {
    expect(deriveExtension("myproject")).toBe(".tar.gz");
  });

  it("falls back to .tar.gz for undefined (git refs, no filename/URL to derive from)", () => {
    expect(deriveExtension(undefined)).toBe(".tar.gz");
  });

  it("falls back to .tar.gz for a malformed URL", () => {
    expect(deriveExtension("https://")).toBe(".tar.gz");
  });

  it("lowercases the derived extension", () => {
    expect(deriveExtension("MyProject.ZIP")).toBe(".zip");
  });
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const UPLOAD_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01]);
const SUBMITTED_SHA = sha256(UPLOAD_BYTES);
const CANONICAL_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
const CANONICAL_SHA = sha256(CANONICAL_BYTES);
const REBUILD_ID = "11111111-2222-3333-4444-555555555555";
const CANONICAL_KEY = `staging/${REBUILD_ID}/verify/canonical-source`;
const FETCHED_VERIFY_KEY = `staging/${REBUILD_ID}/verify/fetched-source`;
const FETCHED_BUILD_KEY = `staging/${REBUILD_ID}/build/fetched-source`;
const OTHER_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

const UPLOADED: SourceReference = {
  type: "private_tarball",
  visibility: "public",
  tarball_sha256: SUBMITTED_SHA,
  source_sha256: SUBMITTED_SHA,
  upload_id: "upload-1",
};

const FROM_URL: SourceReference = {
  type: "source_uri",
  visibility: "public",
  source_uri: "https://example.com/archives/counter.zip",
  source_sha256: SUBMITTED_SHA,
};

type Staging = Record<string, Uint8Array | undefined | (() => never)>;

function resolution(
  staging: Staging = {},
  upload: { bytes: Uint8Array; filename?: string } | undefined | (() => never) = { bytes: UPLOAD_BYTES, filename: "counter.tar.gz" },
) {
  return {
    readStagingObjectBytes: async (key: string) => {
      const entry = staging[key];
      return typeof entry === "function" ? entry() : entry;
    },
    readStagedUploadBytes: async () => (typeof upload === "function" ? upload() : upload),
    peekStagedUploadFilename: async () => "counter.tar.gz",
  } as unknown as SourceResolutionService;
}

const CANONICAL = { sha256: CANONICAL_SHA, key: CANONICAL_KEY, format: "gzip" };
const STAGED = { rebuildId: REBUILD_ID, buildMode: "verify" as const };

describe("canonicalArchiveExtension", () => {
  it("names the archive by its FORMAT, not by what the submitter called the container", () => {
    expect(canonicalArchiveExtension("gzip")).toBe(".tar.gz");
    expect(canonicalArchiveExtension("zip")).toBe(".zip");
    expect(canonicalArchiveExtension("tar")).toBe(".tar");
  });

  it("falls back rather than guessing for a format it does not know", () => {
    expect(canonicalArchiveExtension("unknown")).toBe(".tar.gz");
    expect(canonicalArchiveExtension(undefined)).toBe(".tar.gz");
  });
});

describe("declareSourceFileName — the canonical archive names the published copy", () => {
  it("uses the canonical hash and the canonical format, not the submitted filename", async () => {
    const name = await declareSourceFileName(UPLOADED, resolution(), CANONICAL);

    expect(name).toBe(`${CANONICAL_SHA}.tar.gz`);
    expect(sourceSha256FromFileName(name)).toBe(CANONICAL_SHA);
  });

  it("is unchanged when the submitted archive IS the canonical archive", async () => {
    expect(await declareSourceFileName(UPLOADED, resolution())).toBe(`${SUBMITTED_SHA}.tar.gz`);
  });

  it("does not let the container's extension name the archive inside it", async () => {
    expect(deriveExtension("counter.tar.gz.zip")).toBe(".zip");

    const name = await declareSourceFileName(UPLOADED, resolution(), CANONICAL);
    expect(name.endsWith(".tar.gz")).toBe(true);
  });
});

describe("readSourceBytesForPublishing — which bytes land in sources/", () => {
  it("publishes the canonical archive's bytes, read from the key the trusted side hashed", async () => {
    const read = await readSourceBytesForPublishing(UPLOADED, resolution({ [CANONICAL_KEY]: CANONICAL_BYTES }), STAGED, CANONICAL);

    expect(read).toEqual({ ok: true, bytes: CANONICAL_BYTES, extension: ".tar.gz", sha256: CANONICAL_SHA });
  });

  it("refuses a canonical object whose bytes no longer hash to the canonical sha256", async () => {
    const read = await readSourceBytesForPublishing(UPLOADED, resolution({ [CANONICAL_KEY]: OTHER_BYTES }), STAGED, CANONICAL);

    expect(read).toMatchObject({
      ok: false,
      reason: "sha256_mismatch",
      expectedSha256: CANONICAL_SHA,
      actualSha256: sha256(OTHER_BYTES),
    });
  });

  it("reports a missing canonical object rather than falling back to the submitted bytes", async () => {
    const read = await readSourceBytesForPublishing(UPLOADED, resolution(), STAGED, CANONICAL);

    expect(read).toMatchObject({ ok: false, reason: "no_staged_copy" });
  });

  it("reads the staged upload when there is no canonical archive, and re-hashes it", async () => {
    const read = await readSourceBytesForPublishing(UPLOADED, resolution(), STAGED);

    expect(read).toEqual({ ok: true, bytes: UPLOAD_BYTES, extension: ".tar.gz", sha256: SUBMITTED_SHA });
  });

  it("refuses a staged upload whose bytes do not hash to the declared source_sha256", async () => {
    const read = await readSourceBytesForPublishing(UPLOADED, resolution({}, { bytes: OTHER_BYTES, filename: "counter.tar.gz" }), STAGED);

    expect(read).toMatchObject({ ok: false, reason: "sha256_mismatch", expectedSha256: SUBMITTED_SHA });
  });

  it("reads a URL source from the copy staged before the build, never from the URL", async () => {
    const read = await readSourceBytesForPublishing(FROM_URL, resolution({ [FETCHED_VERIFY_KEY]: UPLOAD_BYTES }), STAGED);

    expect(read).toEqual({ ok: true, bytes: UPLOAD_BYTES, extension: ".zip", sha256: SUBMITTED_SHA });
  });

  it("finds the staged copy under the other build mode when the recorded mode has none", async () => {
    const read = await readSourceBytesForPublishing(FROM_URL, resolution({ [FETCHED_BUILD_KEY]: UPLOAD_BYTES }), STAGED);

    expect(read).toMatchObject({ ok: true, sha256: SUBMITTED_SHA });
  });

  it("refuses a staged URL copy whose bytes do not hash to the declared source_sha256", async () => {
    const read = await readSourceBytesForPublishing(FROM_URL, resolution({ [FETCHED_VERIFY_KEY]: OTHER_BYTES }), STAGED);

    expect(read).toMatchObject({ ok: false, reason: "sha256_mismatch", expectedSha256: SUBMITTED_SHA, actualSha256: sha256(OTHER_BYTES) });
  });

  it("reports a URL source with no staged copy as unavailable rather than fetching it again", async () => {
    const read = await readSourceBytesForPublishing(FROM_URL, resolution(), STAGED);

    expect(read).toMatchObject({ ok: false, reason: "no_staged_copy" });
  });

  it("reports a staging read error as such, without publishing anything", async () => {
    const boom = () => {
      throw new Error("staging object is 60000000 bytes, over the ceiling");
    };
    const read = await readSourceBytesForPublishing(FROM_URL, resolution({ [FETCHED_VERIFY_KEY]: boom }), STAGED);

    expect(read).toMatchObject({ ok: false, reason: "staging_read_failed" });
    expect((read as { detail: string }).detail).toContain("over the ceiling");
  });

  it("has nothing to publish for a git reference", async () => {
    const git: SourceReference = { type: "git", repo: "https://github.com/x/y", rev: "a".repeat(40), source_sha256: SUBMITTED_SHA };

    expect(await readSourceBytesForPublishing(git, resolution(), STAGED)).toMatchObject({ ok: false, reason: "source_type_not_publishable" });
  });

  it("has nothing to publish without a declared sha256 to publish under", async () => {
    const undeclared = { ...UPLOADED, source_sha256: undefined } as unknown as SourceReference;

    expect(await readSourceBytesForPublishing(undeclared, resolution(), STAGED)).toMatchObject({ ok: false, reason: "no_declared_sha256" });
  });
});

describe("publication fetches nothing", () => {
  it("the publish-side reader has no network dependency at all", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/modules/source-resolution/publish-source-bytes.util.ts", import.meta.url)),
      "utf8",
    );

    expect(source).not.toMatch(/policy-bound-fetch|fetch-policy|\bfetch\(/);
  });
});
