import type { SourceReference } from "@scvs/core";
import { normalizePolicy } from "@scvs/core/fetch-policy";
import { fetchThroughDestinationPolicy } from "@scvs/core/policy-bound-fetch";
import type { SourceResolutionService } from "./source-resolution.service.js";

const FETCH_TIMEOUT_MS = 120_000;
/** How many bytes of submitter-controlled source archive this service will hold at once. */
export const MAX_ARCHIVE_BYTES = 52_428_800; // 50 MiB

/** Enough for a real chain. */
const MAX_REDIRECTS = 5;

/** Built here because it is a property of this call site rather than of configuration. */
const DESTINATION_POLICY = normalizePolicy({
  allowedSchemes: ["https:"],
  blockPrivateRanges: true,
  maxResponseBytes: MAX_ARCHIVE_BYTES,
  timeoutMs: FETCH_TIMEOUT_MS,
});

const FALLBACK_EXTENSION = ".tar.gz";

export type FetchedSource = { bytes: Uint8Array; extension: string };

/**
 * Both fields come off the `Rebuild` row, whose `canonicalSourceSha256` this service computed from the bytes at
 * `key` itself.
 */
export type CanonicalSource = { sha256: string; key: string; format?: string };

/** The extension the canonical archive is published under, from the format the sandbox reported. */
export function canonicalArchiveExtension(format: string | undefined): string {
  if (format === "gzip") return ".tar.gz";
  if (format === "zip") return ".zip";
  if (format === "tar") return ".tar";
  return FALLBACK_EXTENSION;
}

/**
 * Extracts a plausible archive extension from a filename or URL path — `.tar.gz`/`.tar.bz2` as one unit (not
 * just the last `.`-segment), otherwise the last segment, otherwise the fallback.
 */
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

/**
 * `private_tarball` needs a DB lookup (`Upload.filename`) but not the S3 read `fetchSourceBytesForPublishing`
 * itself performs.
 */
export async function declareSourceFileName(
  sourceRef: SourceReference,
  sourceResolution: SourceResolutionService,
  canonical?: CanonicalSource,
): Promise<string> {
  // A name built from the submitted hash would break that in both halves.
  if (canonical) return `${canonical.sha256}${canonicalArchiveExtension(canonical.format)}`;
  const sha256 = sourceRef.source_sha256;
  if (sourceRef.type === "private_tarball" && sourceRef.upload_id) {
    const filename = await sourceResolution.peekStagedUploadFilename(sourceRef.upload_id);
    return `${sha256}${deriveExtension(filename)}`;
  }
  const url = sourceRef.type === "hosted_tarball" ? sourceRef.tarball_url : sourceRef.type === "source_uri" ? sourceRef.source_uri : undefined;
  return `${sha256}${deriveExtension(url)}`;
}

/**
 * `private_tarball` reads the staged upload directly via `SourceResolutionService` (no presign —
 * orchestrator-svc holds direct access), taking the extension from `Upload.filename`.
 */
export async function fetchSourceBytesForPublishing(
  sourceRef: SourceReference,
  sourceResolution: SourceResolutionService,
  canonical?: CanonicalSource,
): Promise<FetchedSource | undefined> {
  // Before every source-ref branch, and independent of all of them: when the archive this verification was
  // produced from is not the submitted one, that is what belongs in `sources/` regardless of how the submission
  // arrived.
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
    // This URL is submitter-supplied and this process holds the publishing credential, the staging-bucket
    // credential and database access, inside the VPC.
    const fetched = await fetchThroughDestinationPolicy(url, {
      policy: DESTINATION_POLICY,
      maxRedirects: MAX_REDIRECTS,
    });
    // The extension comes from the URL the submitter declared, not from `fetched.finalUrl`: a redirect to a CDN
    // path with no extension (or a different one) says nothing about what the archive is, and the declared URL
    // is what `declareSourceFileName` already computed the published name from.
    return { bytes: fetched.bytes, extension: deriveExtension(url) };
  } catch {
    return undefined;
  }
}
