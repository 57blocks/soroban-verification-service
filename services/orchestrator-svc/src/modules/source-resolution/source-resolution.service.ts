import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createS3Client, deleteObject, getObjectBytes, presignGetUrl, putObjectBytes } from "@scvs/aws";
import type { StagingStorageConfig } from "@scvs/config";
import { UploadJobReferencesRepository, UploadsRepository } from "@scvs/db";
import {
  ScvsLogger,
  type BuildMode,
  type SourceReference as SourceReferenceDto,
} from "@scvs/core";
import { FetchPolicyError, ResponseTooLargeError, checkUrl, normalizePolicy } from "@scvs/core/fetch-policy";
import { fetchedSourceKey } from "../../common/staging-keys.util.js";
import { MAX_ARCHIVE_BYTES } from "./fetch-source-bytes.util.js";
import { fetchThroughDestinationPolicy } from "@scvs/core/policy-bound-fetch";
import type { AppConfigService } from "../../config/configuration.js";

/**
 * The destination policy for the dispatch-path fetch: deliberately the same shape as
 * `fetch-source-bytes.util.ts`'s, down to sharing its `MAX_ARCHIVE_BYTES`, because two policies over
 * one destination set is how one of them quietly stops matching the other.
 */
const DISPATCH_SOURCE_POLICY = normalizePolicy({
  allowedSchemes: ["https:"],
  blockPrivateRanges: true,
  maxResponseBytes: MAX_ARCHIVE_BYTES,
  timeoutMs: 120_000,
});

/** Same budget as the publish path's, and for the same reason: GitHub archive URLs take a hop. */
const MAX_REDIRECTS = 5;

/** The message of a thrown value, for a `detail` a submitter reads. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `resolveSourceRefForDispatch` is the entry point; `resolvePrivateUploadSourceRef` is its upload arm, still
 * called directly by tests.
 */
@Injectable()
export class SourceResolutionService {
  private readonly logger = new ScvsLogger("source-resolution");

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(UploadsRepository) private readonly uploads: UploadsRepository,
    @Inject(UploadJobReferencesRepository) private readonly uploadJobReferences: UploadJobReferencesRepository
  ) {}

  /** | arm | outcome | | :-- | :-- | | `private_tarball` | unchanged. */
  async resolveSourceRefForDispatch(
    sourceRef: SourceReferenceDto,
    rebuildId: string,
    mode: BuildMode,
  ): Promise<
    | { ok: true; sourceRef: SourceReferenceDto }
    | { ok: false; reason: string; detail: string }
  > {
    if (sourceRef.type === "private_tarball") {
      return this.resolvePrivateUploadSourceRef(sourceRef);
    }
    if (sourceRef.type === "git" || sourceRef.type === "hosted_tarball") {
      return {
        ok: false,
        reason: "source_ref_unsupported",
        detail:
          `Source reference type "${sourceRef.type}" is not accepted. ` +
          "Submit an uploaded archive (upload_id) or an https source_uri.",
      };
    }
    return this.stageRemoteSource(sourceRef, rebuildId, mode);
  }

  /**
   * Fetches a submitter-supplied `source_uri` under the destination policy, checks the bytes against the hash
   * the submission declared, stages them, and returns the ref with `source_uri` replaced by a presigned GET of
   * the staged object.
   */
  protected async stageRemoteSource(
    sourceRef: SourceReferenceDto,
    rebuildId: string,
    mode: BuildMode,
  ): Promise<
    | { ok: true; sourceRef: SourceReferenceDto }
    | { ok: false; reason: string; detail: string }
  > {
    const uri = sourceRef.source_uri;
    if (!uri) {
      return {
        ok: false,
        reason: "source_uri_missing",
        detail: "A source_uri is required when no upload_id was submitted.",
      };
    }

    // `checkUrl` covers the three refusals a submitter can act on without knowing anything about our network: a
    // non-absolute URI (the bare-path form `SOURCE_URI_PATTERN` still admits at submit), a scheme that is not
    // `https:`, and an IP-literal host in a blocked range.
    try {
      checkUrl(DISPATCH_SOURCE_POLICY, uri);
    } catch (error) {
      return {
        ok: false,
        reason: "source_uri_refused",
        detail: describeError(error),
      };
    }

    let bytes: Uint8Array;
    try {
      ({ bytes } = await this.fetchUnderPolicy(uri));
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        return { ok: false, reason: "source_archive_too_large", detail: describeError(error) };
      }
      // `UpstreamNotDeliveredError` is deliberately not caught here — an admitted peer that delivered nothing
      // falls through below.
      if (error instanceof FetchPolicyError) {
        return { ok: false, reason: "source_uri_refused", detail: describeError(error) };
      }
      return { ok: false, reason: "source_uri_not_materialized", detail: describeError(error) };
    }

    // This is the cheaper refusal: the bytes are already in hand here, so a mismatch costs no Batch job.
    const digest = createHash("sha256").update(bytes).digest("hex");
    const declared = sourceRef.source_sha256?.toLowerCase();
    if (declared && digest !== declared) {
      return {
        ok: false,
        reason: "source_hash_mismatch",
        detail: `Source SHA-256 mismatch: expected ${declared}, got ${digest}.`,
      };
    }

    const staging = this.configService.get("stagingStorage", { infer: true });
    const s3 = createS3Client({ region: staging.region });
    const key = fetchedSourceKey(rebuildId, mode);
    try {
      await this.putStagedObject(s3, staging.bucket, key, bytes);
      const stagedUri = await this.presignUploadGet(s3, staging.bucket, key);
      this.logger.log("staged a fetched source archive for the builder", {
        rebuild_id: rebuildId,
        mode,
        bytes: bytes.byteLength,
      });
      return { ok: true, sourceRef: { ...sourceRef, source_uri: stagedUri } };
    } catch (error) {
      // Our own storage failed, not the submitter's source. Named separately so it is not read as "your URL is
      // bad" by someone who would then go and check a URL that was fine.
      return {
        ok: false,
        reason: "source_stage_copy_failed",
        detail: describeError(error),
      };
    }
  }

  async resolvePrivateUploadSourceRef(
    sourceRef: SourceReferenceDto
  ): Promise<
    | { ok: true; sourceRef: SourceReferenceDto }
    | { ok: false; reason: string; detail: string }
  > {
    if (sourceRef.type !== "private_tarball" || !sourceRef.upload_id) {
      return { ok: true, sourceRef };
    }
    const upload = await this.uploads.getUpload(sourceRef.upload_id);
    if (!upload || new Date(upload.expiresAt).getTime() <= Date.now()) {
      return {
        ok: false,
        reason: "private_upload_unavailable",
        detail: "Private source upload is missing or expired.",
      };
    }
    if (!upload.received || !upload.path) {
      return {
        ok: false,
        reason: "private_upload_incomplete",
        detail:
          "Private source upload exists, but no archive bytes were received.",
      };
    }
    const staging =
      this.configService.get("stagingStorage", { infer: true });
    const s3 = createS3Client({ region: staging.region });
    const sourceUri = await this.presignUploadGet(s3, staging.bucket, upload.path);
    return { ok: true, sourceRef: { ...sourceRef, source_uri: sourceUri } };
  }

  /** The outbound half of `stageRemoteSource`, and the S3 write beside it. */
  protected fetchUnderPolicy(uri: string): Promise<{ bytes: Uint8Array; finalUrl: string }> {
    return fetchThroughDestinationPolicy(uri, {
      policy: DISPATCH_SOURCE_POLICY,
      maxRedirects: MAX_REDIRECTS,
    });
  }

  protected putStagedObject(
    s3: ReturnType<typeof createS3Client>,
    bucket: string,
    key: string,
    bytes: Uint8Array,
  ): Promise<void> {
    // `application/octet-stream` deliberately, never a type derived from the submitter's URL: that would be
    // their claim about their own bytes, stored where a later reader could take it for ours.
    return putObjectBytes(s3, bucket, key, bytes, "application/octet-stream");
  }

  /**
   * The one S3 touchpoint on the resolve path, isolated as a method so the e2e suite can substitute it
   * (`jest.spyOn`).
   */
  protected presignUploadGet(
    s3: ReturnType<typeof createS3Client>,
    bucket: string,
    key: string
  ): Promise<string> {
    return presignGetUrl(s3, bucket, key);
  }

  /**
   * `orchestrator-svc` already holds direct S3 access, so this reads the object straight rather than presigning
   * a URL and then fetching it back over HTTP.
   */
  async readStagedUploadBytes(
    sourceRef: SourceReferenceDto
  ): Promise<{ bytes: Uint8Array; filename?: string } | undefined> {
    if (sourceRef.type !== "private_tarball" || !sourceRef.upload_id) {
      return undefined;
    }
    const upload = await this.uploads.getUpload(sourceRef.upload_id);
    if (!upload?.received || !upload.path) {
      return undefined;
    }
    const staging = this.configService.get("stagingStorage", { infer: true });
    const s3 = createS3Client({ region: staging.region });
    const bytes = await getObjectBytes(s3, staging.bucket, upload.path);
    if (!bytes) return undefined;
    return { bytes, filename: upload.filename };
  }

  /** Returns `undefined` for a missing upload row, never throws. */
  /** Bytes at a staging key this service was told about, rather than one it resolved from an upload row. */
  async readStagingObjectBytes(key: string): Promise<Uint8Array | undefined> {
    const staging = this.configService.get("stagingStorage", { infer: true });
    const s3 = createS3Client({ region: staging.region });
    return (await getObjectBytes(s3, staging.bucket, key)) ?? undefined;
  }

  async peekStagedUploadFilename(uploadId: string): Promise<string | undefined> {
    const upload = await this.uploads.getUpload(uploadId);
    return upload?.filename;
  }

  /**
   * Deletes a private upload's staged bytes (S3 object + `uploads` row) — the termination-time counterpart to
   * `UploadCleanupService`'s 30-minute sweep.
   */
  async deleteStagedUpload(sourceRef: SourceReferenceDto): Promise<void> {
    if (sourceRef.type !== "private_tarball" || !sourceRef.upload_id) {
      return;
    }
    try {
      const ceilingMs = this.configService.get("stagingSweepJobAgeCeilingMs", { infer: true });
      const owed = await this.uploadJobReferences.hasOutstandingObligation(
        sourceRef.upload_id,
        ceilingMs,
        new Date(),
        this.configService.get("maxJobRetryAttempts", { infer: true }),
      );
      if (owed) {
        this.logger.log("skipping staged-upload delete: another job still owes this upload a source publish", {
          upload_id: sourceRef.upload_id,
        });
        return;
      }
      const upload = await this.uploads.deleteUpload(sourceRef.upload_id);
      if (!upload?.path) {
        return;
      }
      const staging = this.configService.get("stagingStorage", { infer: true });
      const s3 = createS3Client({ region: staging.region });
      await deleteObject(s3, staging.bucket, upload.path);
    } catch (error) {
      this.logger.warn("failed to delete staged upload at job termination", {
        upload_id: sourceRef.upload_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
