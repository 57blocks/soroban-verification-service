import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { RebuildErrorCode, SourceCanonicalisation, SourceReference } from "@scvs/core";
import {
  FetchPolicyError,
  ResponseTooLargeError,
  createGuardedFetch,
  normalizePolicy,
  readBoundedBytes,
} from "@scvs/core/fetch-policy";
import { alignArchiveNameForCli } from "./archive-format.js";
import { byteSize, sha256File } from "@scvs/core/process";

export type MaterializedSource = {
  mode: "public_repo" | "hosted_tarball" | "private_uploaded_tarball" | "source_uri";
  visibility: "public" | "private";
  source_uri?: string;
  /**
   * Optional because the git arm has no archive to hash: a checkout is a tree, and there is no canonical
   * serialisation of it whose sha256 would mean anything.
   */
  source_sha256?: string;
  workspace_path: string;
  local_path?: string;
  /** **The archive `stellar contract verify` must be handed**. */
  canonical_path?: string;
  /** Absent when the submitted bytes were already the canonical archive. */
  canonicalisation?: SourceCanonicalisation;
  retained_after_verification: false;
};

/**
 * The legacy `materializeSource` called `getUpload(upload_id)` from `@scvs/db` to resolve a `private_tarball`;
 * this file cannot.
 */
/**
 * Sourced from `ConfigService` by the one Nest-managed caller in this chain (builder.service.ts) and passed
 * down through `MaterializeSourceInput.config`.
 */
export type FetchSourceConfig = {
  artifactDir?: string;
  sourceFetchTimeoutMs?: number;
  /** The bound on the *compressed* bytes we download. The uncompressed bound is an ArchiveLimit. */
  maxSourceArchiveBytes?: number;
};

// Intersected with `config` (rather than repeated on all 4 arms) since it's the same field regardless of which
// `sourceRef.type` this input carries.
export type MaterializeSourceInput = (
  | { sourceRef: Extract<SourceReference, { type: "git" }> }
  | { sourceRef: Extract<SourceReference, { type: "hosted_tarball" }> }
  | { sourceRef: Extract<SourceReference, { type: "private_tarball" }>; resolvedLocalPath: string }
  | { sourceRef: Extract<SourceReference, { type: "source_uri" }>; resolvedLocalPath?: string }
) & { config?: FetchSourceConfig };

export type SourceFetchResult =
  | { ok: true; source: MaterializedSource }
  | {
      ok: false;
      status:
        | "source_unavailable"
        | "source_hash_mismatch"
        | "build_failed";
      reason: RebuildErrorCode;
      detail: string;
    };

export async function materializeSource(input: MaterializeSourceInput): Promise<SourceFetchResult> {
  const source = input.sourceRef;

  // `orchestrator-svc` refuses them at dispatch too; this arm is what stops the refusal depending on it.
  if (source.type === "git" || source.type === "hosted_tarball") {
    return {
      ok: false,
      status: "source_unavailable",
      reason: "source_ref_unsupported",
      detail:
        `Source reference type "${source.type}" is not accepted. ` +
        "Submit an uploaded archive (upload_id) or an https source_uri.",
    };
  }

  if (source.type === "private_tarball") {
    // No `@scvs/db` lookup here: `resolvedLocalPathOf(input)` is a location the caller already resolved from
    // `upload_id` (typically the same value it wrote into `source_ref.source_uri` before submitting the Batch
    // job).
    return materializeArchiveSource(
      {
        mode: "private_uploaded_tarball",
        visibility: "private",
        source_uri: resolvedLocalPathOf(input),
        source_sha256: source.source_sha256 || source.tarball_sha256,
      },
      input.config,
    );
  }

  // source.type === "source_uri"
  return materializeArchiveSource(
    {
      mode: "source_uri",
      visibility: source.visibility,
      source_uri: resolvedLocalPathOf(input) || source.source_uri,
      source_sha256: source.source_sha256,
    },
    input.config,
  );
}

/**
 * `input` itself is never narrowed by checking the *aliased* `source` variable above (TS only narrows the exact
 * expression it tested, not a copy of one of its properties).
 */
function resolvedLocalPathOf(input: MaterializeSourceInput): string | undefined {
  return "resolvedLocalPath" in input ? input.resolvedLocalPath : undefined;
}

async function materializeArchiveSource(
  input: {
    mode: MaterializedSource["mode"];
    visibility: MaterializedSource["visibility"];
    source_uri?: string;
    source_sha256: string;
  },
  config?: FetchSourceConfig,
): Promise<SourceFetchResult> {
  if (!input.source_uri) {
    return {
      ok: false,
      status: "source_unavailable",
      reason: "source_uri_missing",
      detail: "A source_uri is required to fetch source material.",
    };
  }

  let localPath = localPathFromUri(input.source_uri);
  if (!localPath) {
    const downloaded = await downloadSourceArchive(input.source_uri, config);
    if (!downloaded.ok) return downloaded;
    localPath = downloaded.path;
  }

  const sizeCheck = await validateSourceSize(localPath, config);
  if (!sizeCheck.ok) return sizeCheck;

  const actualHash = (await sha256File(localPath)).toLowerCase();
  if (actualHash !== input.source_sha256.toLowerCase()) {
    return {
      ok: false,
      status: "source_hash_mismatch",
      reason: "source_sha256_mismatch",
      detail: `Source SHA-256 mismatch: expected ${input.source_sha256}, got ${actualHash}.`,
    };
  }

  // No tarball inspection here.

  // This gives the same bytes a name the CLI accepts.
  const aligned = await alignArchiveNameForCli({ localPath, artifactRoot: artifactRoot(config) });

  return sourceOk(
    input.mode,
    input.visibility,
    aligned.path,
    // `actualHash`, not the submitted value.
    actualHash,
    aligned.path,
  );
}

/** The one outbound request this container still makes. */
async function downloadSourceArchive(
  sourceUri: string,
  config?: FetchSourceConfig,
): Promise<{ ok: true; path: string } | Extract<SourceFetchResult, { ok: false }>> {
  const maxBytes = maxSourceArchiveBytes(config);
  const policy = normalizePolicy({
    allowedSchemes: ["https:"],
    blockPrivateRanges: true,
    followRedirects: false,
    maxResponseBytes: maxBytes,
    timeoutMs: config?.sourceFetchTimeoutMs || Number(process.env.SCVS_SOURCE_FETCH_TIMEOUT_MS || 120_000),
  });

  if (!isPresignedObjectUrl(sourceUri)) {
    return {
      ok: false,
      status: "source_unavailable",
      reason: "source_uri_refused",
      detail:
        "The build sandbox only fetches a presigned staging URL. A source location is resolved by the " +
        "verifier before the job is dispatched, not by the sandbox.",
    };
  }

  const root = artifactRoot(config);
  await mkdir(root, { recursive: true });
  const downloadDir = await mkdtemp(join(root, "download-"));
  // `alignArchiveNameForCli` renames from the magic number downstream, so this name carries no meaning and
  // needs none — the staging key's basename has no extension.
  const localPath = join(downloadDir, basename(new URL(sourceUri).pathname) || "source.tar.gz");

  try {
    const guardedFetch = createGuardedFetch(policy, fetch);
    const response = await guardedFetch(sourceUri);
    if (!response.ok) {
      return {
        ok: false,
        status: "source_unavailable",
        reason: "source_uri_not_materialized",
        detail: `Staged source fetch returned HTTP ${response.status}.`,
      };
    }
    // Metered while it arrives rather than buffered and measured afterwards: `validateSourceSize` below still
    // checks the file, but by then the bytes are already in memory and on disk.
    await writeFile(localPath, await readBoundedBytes(response, maxBytes));
    return { ok: true, path: localPath };
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      return {
        ok: false,
        status: "source_unavailable",
        reason: "source_archive_too_large",
        detail: error.message,
      };
    }
    // Collapsed into `source_uri_not_materialized` it reads as "the staging bucket was down", which is what a
    // reader would go and check instead.
    if (error instanceof FetchPolicyError) {
      return {
        ok: false,
        status: "source_unavailable",
        reason: "source_uri_refused",
        detail: error.message,
      };
    }
    return {
      ok: false,
      status: "source_unavailable",
      reason: "source_uri_not_materialized",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Whether a URL carries the SigV4 query parameters a presigned S3 GET has. */
function isPresignedObjectUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.searchParams.has("X-Amz-Signature") && url.searchParams.has("X-Amz-Credential");
}

async function validateSourceSize(
  localPath: string,
  config?: FetchSourceConfig,
): Promise<SourceFetchResult | { ok: true }> {
  const maxBytes = maxSourceArchiveBytes(config);
  const size = await byteSize(localPath);
  if (size > maxBytes) {
    return {
      ok: false,
      status: "source_unavailable",
      reason: "source_archive_too_large",
      detail: `Source archive is ${size} bytes, exceeding limit ${maxBytes}.`,
    };
  }
  return { ok: true };
}

function sourceOk(
  mode: MaterializedSource["mode"],
  visibility: MaterializedSource["visibility"],
  sourceUri: string | undefined,
  sourceSha256: string | undefined,
  localPath: string,
): SourceFetchResult {
  return {
    ok: true,
    source: {
      mode,
      visibility,
      source_uri: sourceUri,
      ...(sourceSha256 ? { source_sha256: sourceSha256 } : {}),
      workspace_path: localPath,
      local_path: localPath,
      retained_after_verification: false,
    },
  };
}

/** Where this container may write. */
export function artifactRoot(config?: FetchSourceConfig): string {
  return config?.artifactDir || process.env.SCVS_ARTIFACT_DIR || join(tmpdir(), "scvs-artifacts");
}

/** The ceiling on the *compressed* bytes this container will take. */
function maxSourceArchiveBytes(config?: FetchSourceConfig): number {
  return config?.maxSourceArchiveBytes || Number(process.env.SCVS_MAX_SOURCE_ARCHIVE_BYTES || 50 * 1024 * 1024);
}

function localPathFromUri(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const candidate = value.startsWith("file://") ? new URL(value).pathname : value;
  if (!candidate.startsWith("/")) {
    return undefined;
  }
  return existsSync(candidate) ? candidate : undefined;
}
