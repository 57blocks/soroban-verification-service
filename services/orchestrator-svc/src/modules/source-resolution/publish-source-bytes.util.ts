import { createHash } from "node:crypto";
import { buildModes, type BuildMode, type SourceReference } from "@scvs/core";
import { fetchedSourceKey } from "../../common/staging-keys.util.js";
import type { SourceResolutionService } from "./source-resolution.service.js";

export const MAX_ARCHIVE_BYTES = 52_428_800; // 50 MiB

const FALLBACK_EXTENSION = ".tar.gz";

export type CanonicalSource = { sha256: string; key: string; format?: string };

/** Where the copy staged before the build lives: under the rebuild, in the mode that ran. */
export type StagedSourceLocator = { rebuildId: string; buildMode?: BuildMode };

export type SourceBytesUnavailableReason =
  | "no_staged_copy"
  | "sha256_mismatch"
  | "staging_read_failed"
  | "no_declared_sha256"
  | "source_type_not_publishable";

export type SourceBytesForPublishing =
  | { ok: true; bytes: Uint8Array; extension: string; sha256: string }
  | {
      ok: false;
      reason: SourceBytesUnavailableReason;
      detail: string;
      expectedSha256?: string;
      actualSha256?: string;
    };

export function canonicalArchiveExtension(format: string | undefined): string {
  if (format === "gzip") return ".tar.gz";
  if (format === "zip") return ".zip";
  if (format === "tar") return ".tar";
  return FALLBACK_EXTENSION;
}

export function deriveExtension(nameOrUrl: string | undefined): string {
  if (!nameOrUrl) return FALLBACK_EXTENSION;
  let path: string;
  try {
    path = /^https?:\/\//i.test(nameOrUrl) ? new URL(nameOrUrl).pathname : nameOrUrl;
  } catch {
    return FALLBACK_EXTENSION;
  }
  const match = /(\.tar\.[a-z0-9]+|\.[a-z0-9]+)$/i.exec(path);
  return match ? match[1].toLowerCase() : FALLBACK_EXTENSION;
}

export async function declareSourceFileName(
  sourceRef: SourceReference,
  sourceResolution: SourceResolutionService,
  canonical?: CanonicalSource,
): Promise<string> {
  if (canonical) return `${canonical.sha256}${canonicalArchiveExtension(canonical.format)}`;
  const sha256 = sourceRef.source_sha256;
  if (sourceRef.type === "private_tarball" && sourceRef.upload_id) {
    const filename = await sourceResolution.peekStagedUploadFilename(sourceRef.upload_id);
    return `${sha256}${deriveExtension(filename)}`;
  }
  const url = sourceRef.type === "hosted_tarball" ? sourceRef.tarball_url : sourceRef.type === "source_uri" ? sourceRef.source_uri : undefined;
  return `${sha256}${deriveExtension(url)}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The bytes that may land in `sources/`: a copy this service staged itself, re-hashed here against the
 * hash the published name carries. Nothing is fetched from a submitter-supplied URL at this point.
 */
export async function readSourceBytesForPublishing(
  sourceRef: SourceReference,
  sourceResolution: SourceResolutionService,
  staged: StagedSourceLocator,
  canonical?: CanonicalSource,
): Promise<SourceBytesForPublishing> {
  if (canonical) {
    const read = await readStagingObject(sourceResolution, canonical.key);
    if (!read.ok) return read;
    if (!read.bytes) return noStagedCopy(`No canonical source archive at ${canonical.key}.`);
    return verified(read.bytes, canonical.sha256, canonicalArchiveExtension(canonical.format), canonical.key);
  }

  const declared = sourceRef.source_sha256?.toLowerCase();
  if (!declared) {
    return { ok: false, reason: "no_declared_sha256", detail: "The source reference carries no source_sha256 to publish under." };
  }

  if (sourceRef.type === "private_tarball") {
    let upload: { bytes: Uint8Array; filename?: string } | undefined;
    try {
      upload = await sourceResolution.readStagedUploadBytes(sourceRef);
    } catch (error) {
      return readFailed(`upload ${sourceRef.upload_id ?? "(no upload_id)"}`, error);
    }
    if (!upload) return noStagedCopy(`Upload ${sourceRef.upload_id ?? "(no upload_id)"} is no longer staged.`);
    return verified(upload.bytes, declared, deriveExtension(upload.filename), `upload ${sourceRef.upload_id}`);
  }

  if (sourceRef.type === "source_uri") {
    for (const mode of modesToTry(staged.buildMode)) {
      const key = fetchedSourceKey(staged.rebuildId, mode);
      const read = await readStagingObject(sourceResolution, key);
      if (!read.ok) return read;
      if (read.bytes) return verified(read.bytes, declared, deriveExtension(sourceRef.source_uri), key);
    }
    return noStagedCopy(`No staged copy of the fetched source under rebuild ${staged.rebuildId}.`);
  }

  return {
    ok: false,
    reason: "source_type_not_publishable",
    detail: `Source reference type "${sourceRef.type}" has no staged copy this service can publish.`,
  };
}

function modesToTry(preferred: BuildMode | undefined): BuildMode[] {
  const first = preferred ?? "verify";
  return [first, ...buildModes.filter((mode) => mode !== first)];
}

async function readStagingObject(
  sourceResolution: SourceResolutionService,
  key: string,
): Promise<{ ok: true; bytes: Uint8Array | undefined } | Extract<SourceBytesForPublishing, { ok: false }>> {
  try {
    return { ok: true, bytes: await sourceResolution.readStagingObjectBytes(key) };
  } catch (error) {
    return readFailed(key, error);
  }
}

function readFailed(what: string, error: unknown): Extract<SourceBytesForPublishing, { ok: false }> {
  return {
    ok: false,
    reason: "staging_read_failed",
    detail: `Reading ${what} failed: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function noStagedCopy(detail: string): Extract<SourceBytesForPublishing, { ok: false }> {
  return { ok: false, reason: "no_staged_copy", detail };
}

function verified(bytes: Uint8Array, expectedSha256: string, extension: string, origin: string): SourceBytesForPublishing {
  const actual = sha256Hex(bytes);
  const expected = expectedSha256.toLowerCase();
  if (actual !== expected) {
    return {
      ok: false,
      reason: "sha256_mismatch",
      detail: `${origin} hashes to ${actual}, not the ${expected} it would be published as.`,
      expectedSha256: expected,
      actualSha256: actual,
    };
  }
  return { ok: true, bytes, extension, sha256: actual };
}
