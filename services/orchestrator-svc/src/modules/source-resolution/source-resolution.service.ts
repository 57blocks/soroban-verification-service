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

// Must stay the same policy as fetch-source-bytes.util.ts's: one destination set, one policy.
const DISPATCH_SOURCE_POLICY = normalizePolicy({
  allowedSchemes: ["https:"],
  blockPrivateRanges: true,
  maxResponseBytes: MAX_ARCHIVE_BYTES,
  timeoutMs: 120_000,
});

const MAX_REDIRECTS = 5;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class SourceResolutionService {
  private readonly logger = new ScvsLogger("source-resolution");

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(UploadsRepository) private readonly uploads: UploadsRepository,
    @Inject(UploadJobReferencesRepository) private readonly uploadJobReferences: UploadJobReferencesRepository
  ) {}

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
      if (error instanceof FetchPolicyError) {
        return { ok: false, reason: "source_uri_refused", detail: describeError(error) };
      }
      return { ok: false, reason: "source_uri_not_materialized", detail: describeError(error) };
    }

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
    // Never a content type derived from the submitter's URL.
    return putObjectBytes(s3, bucket, key, bytes, "application/octet-stream");
  }

  // Isolated as a method so tests can substitute it.
  protected presignUploadGet(
    s3: ReturnType<typeof createS3Client>,
    bucket: string,
    key: string
  ): Promise<string> {
    return presignGetUrl(s3, bucket, key);
  }

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

  async readStagingObjectBytes(key: string): Promise<Uint8Array | undefined> {
    const staging = this.configService.get("stagingStorage", { infer: true });
    const s3 = createS3Client({ region: staging.region });
    return (await getObjectBytes(s3, staging.bucket, key)) ?? undefined;
  }

  async peekStagedUploadFilename(uploadId: string): Promise<string | undefined> {
    const upload = await this.uploads.getUpload(uploadId);
    return upload?.filename;
  }

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
      await this.deleteStagedObject(s3, staging.bucket, upload.path);
    } catch (error) {
      this.logger.warn("failed to delete staged upload at job termination", {
        upload_id: sourceRef.upload_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  protected deleteStagedObject(
    s3: ReturnType<typeof createS3Client>,
    bucket: string,
    key: string,
  ): Promise<void> {
    return deleteObject(s3, bucket, key);
  }
}
