import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createS3Client, deleteObject } from "@scvs/aws";
import { getStagingStorageConfig } from "@scvs/config";
import { DEFAULT_MAX_JOB_RETRY_ATTEMPTS } from "@scvs/core";
import { UploadJobReferencesRepository, UploadsRepository, type UploadRecord } from "@scvs/db";
import type { AppConfigService } from "../config/configuration.js";

/**
 * Not a local filesystem path: the Builder runs on a separate Batch-managed EC2 host, so uploads must live in
 * the single shared S3 bucket, not on verification-svc's own disk.
 */
export function stagingUploadKey(uploadId: string, filename: string): string {
  return `staging/uploads/${uploadId}/${filename}`;
}

/** Driven by `UploadCleanupScheduler`'s `@Interval`. */
@Injectable()
export class UploadCleanupService {
  // Explicit `@Inject()` — see preflight.controller.ts's comment (tsx/esbuild doesn't emit the decorator
  // metadata Nest's DI would otherwise infer this parameter's type from).
  constructor(
    @Inject(UploadsRepository) private readonly uploads: UploadsRepository,
    @Inject(UploadJobReferencesRepository) private readonly uploadJobReferences: UploadJobReferencesRepository,
    @Inject(ConfigService) private readonly configService: AppConfigService,
  ) {}

  async cleanupUpload(uploadId: string): Promise<void> {
    const upload = await this.uploads.deleteUpload(uploadId);
    await this.removeUploadFiles(upload);
  }

  /**
   * Every other case (no referencing job, no obligation, or every referencing job past the age ceiling) deletes
   * exactly as before this decision.
   */
  async cleanupExpiredUploads(now = Date.now()): Promise<number> {
    const uploads = await this.uploads.listUploads();
    const expired = uploads.filter(
      (upload) => new Date(upload.expiresAt).getTime() <= now,
    );
    const ceilingMs = this.configService.get("stagingSweepJobAgeCeilingMs", { infer: true });
    const toDelete: string[] = [];
    for (const upload of expired) {
      const owed = await this.uploadJobReferences.hasOutstandingObligation(
        upload.id,
        ceilingMs,
        new Date(now),
        // This service does not configure retries, so it compares against `@scvs/core`'s shared default — the
        // same number the orchestrator's SCVS_MAX_JOB_RETRY_ATTEMPTS falls back to.
        DEFAULT_MAX_JOB_RETRY_ATTEMPTS,
      );
      if (owed) continue;
      toDelete.push(upload.id);
    }
    await Promise.all(toDelete.map((uploadId) => this.cleanupUpload(uploadId)));
    return toDelete.length;
  }

  async removeUploadFiles(upload?: UploadRecord): Promise<void> {
    if (!upload?.path) return;
    const staging = getStagingStorageConfig();
    const s3 = createS3Client({ region: staging.region });
    await deleteObject(s3, staging.bucket, upload.path);
  }
}
