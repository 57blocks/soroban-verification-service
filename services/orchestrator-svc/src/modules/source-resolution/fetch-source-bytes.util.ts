import type { SourceReference } from "@scvs/core";
import { normalizePolicy } from "@scvs/core/fetch-policy";
import { fetchThroughDestinationPolicy } from "@scvs/core/policy-bound-fetch";
import type { SourceResolutionService } from "./source-resolution.service.js";

const FETCH_TIMEOUT_MS = 120_000;
export const MAX_ARCHIVE_BYTES = 52_428_800; // 50 MiB

const MAX_REDIRECTS = 5;

const DESTINATION_POLICY = normalizePolicy({
  allowedSchemes: ["https:"],
  blockPrivateRanges: true,
  maxResponseBytes: MAX_ARCHIVE_BYTES,
  timeoutMs: FETCH_TIMEOUT_MS,
});

const FALLBACK_EXTENSION = ".tar.gz";

export type FetchedSource = { bytes: Uint8Array; extension: string };

export type CanonicalSource = { sha256: string; key: string; format?: string };

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

export async function fetchSourceBytesForPublishing(
  sourceRef: SourceReference,
  sourceResolution: SourceResolutionService,
  canonical?: CanonicalSource,
): Promise<FetchedSource | undefined> {
  if (canonical) {
    const bytes = await sourceResolution.readStagingObjectBytes(canonical.key);
    if (!bytes) return undefined;
    return { bytes, extension: canonicalArchiveExtension(canonical.format) };
  }
  if (sourceRef.type === "private_tarball") {
    const staged = await sourceResolution.readStagedUploadBytes(sourceRef);
    if (!staged) return undefined;
    return { bytes: staged.bytes, extension: deriveExtension(staged.filename) };
  }
  if (sourceRef.type === "git") {
    return undefined;
  }
  const url = sourceRef.type === "hosted_tarball" ? sourceRef.tarball_url : sourceRef.source_uri;
  if (!url) return undefined;
  try {
    // Submitter-supplied URL, fetched by a process holding credentials inside the VPC: policy-bound only.
    const fetched = await fetchThroughDestinationPolicy(url, {
      policy: DESTINATION_POLICY,
      maxRedirects: MAX_REDIRECTS,
    });
    // Extension from the declared URL, not finalUrl: declareSourceFileName named the object from it.
    return { bytes: fetched.bytes, extension: deriveExtension(url) };
  } catch {
    return undefined;
  }
}
