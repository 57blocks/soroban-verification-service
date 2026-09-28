import type { SourceReference } from "@scvs/core";
import { sourceSha256FromFileName } from "@scvs/storage-layout";
import {
  canonicalArchiveExtension,
  declareSourceFileName,
  deriveExtension,
  fetchSourceBytesForPublishing,
} from "../src/modules/source-resolution/fetch-source-bytes.util.js";
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

const SUBMITTED_SHA = "a".repeat(64);
const CANONICAL_SHA = "b".repeat(64);
const CANONICAL_KEY = "staging/rebuild-1/verify/canonical-source";
const CANONICAL_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);

const UPLOADED: SourceReference = {
  type: "private_tarball",
  visibility: "public",
  tarball_sha256: SUBMITTED_SHA,
  source_sha256: SUBMITTED_SHA,
  upload_id: "upload-1",
};

function resolution(over: Partial<Record<"staging" | "upload", unknown>> = {}) {
  return {
    readStagingObjectBytes: async (key: string) =>
      key === CANONICAL_KEY ? (over.staging ?? CANONICAL_BYTES) : undefined,
    readStagedUploadBytes: async () =>
      over.upload ?? { bytes: new Uint8Array([0x1f, 0x8b]), filename: "counter.tar.gz" },
    peekStagedUploadFilename: async () => "counter.tar.gz",
  } as unknown as SourceResolutionService;
}

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
    const name = await declareSourceFileName(UPLOADED, resolution(), {
      sha256: CANONICAL_SHA,
      key: CANONICAL_KEY,
      format: "gzip",
    });

    expect(name).toBe(`${CANONICAL_SHA}.tar.gz`);
    expect(sourceSha256FromFileName(name)).toBe(CANONICAL_SHA);
  });

  it("is unchanged when the submitted archive IS the canonical archive", async () => {
    expect(await declareSourceFileName(UPLOADED, resolution())).toBe(`${SUBMITTED_SHA}.tar.gz`);
  });

  it("does not let the container's extension name the archive inside it", async () => {
    expect(deriveExtension("counter.tar.gz.zip")).toBe(".zip");

    const name = await declareSourceFileName(UPLOADED, resolution(), {
      sha256: CANONICAL_SHA,
      key: CANONICAL_KEY,
      format: "gzip",
    });
    expect(name.endsWith(".tar.gz")).toBe(true);
  });
});

describe("fetchSourceBytesForPublishing — which bytes land in sources/", () => {
  it("publishes the canonical archive's bytes, read from the key the trusted side hashed", async () => {
    const fetched = await fetchSourceBytesForPublishing(UPLOADED, resolution(), {
      sha256: CANONICAL_SHA,
      key: CANONICAL_KEY,
      format: "gzip",
    });

    expect(fetched).toEqual({ bytes: CANONICAL_BYTES, extension: ".tar.gz" });
  });

  it("returns nothing when the canonical object is gone, rather than falling back to the submitted bytes", async () => {
    const fetched = await fetchSourceBytesForPublishing(UPLOADED, resolution({ staging: undefined }), {
      sha256: CANONICAL_SHA,
      key: "staging/rebuild-1/verify/absent",
      format: "gzip",
    });

    expect(fetched).toBeUndefined();
  });

  it("reads the staged upload when there is no canonical archive", async () => {
    const fetched = await fetchSourceBytesForPublishing(UPLOADED, resolution());

    expect(fetched?.extension).toBe(".tar.gz");
  });
});
