import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createS3Client, deleteObject } from "@scvs/aws";
import { getStagingStorageConfig } from "@scvs/config";
import { DEFAULT_MAX_JOB_RETRY_ATTEMPTS } from "@scvs/core";
import { UploadJobReferencesRepository, UploadsRepository, type UploadRecord } from "@scvs/db";
import type { AppConfigService } from "../config/configuration.js";

export function stagingUploadKey(uploadId: string, filename: string): string {
  return `staging/uploads/${uploadId}/${filename}`;
}

@Injectable()
export class UploadCleanupService {
  constructor(
    @Inject(UploadsRepository) private readonly uploads: UploadsRepository,
    @Inject(UploadJobReferencesRepository) private readonly uploadJobReferences: UploadJobReferencesRepository,
    @Inject(ConfigService) private readonly configService: AppConfigService,
  ) {}

  async cleanupUpload(uploadId: string): Promise<void> {
    const upload = await this.uploads.deleteUpload(uploadId);
    await this.removeUploadFiles(upload);
  }

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
