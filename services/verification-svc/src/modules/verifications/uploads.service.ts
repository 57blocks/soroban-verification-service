import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { v4 as uuidv4 } from "uuid";
import { createS3Client, putObjectBytes } from "@scvs/aws";
import { getStagingStorageConfig } from "@scvs/config";
import {
  ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES,
  UPLOAD_ARCHIVE_CONTENT_TYPE,
  UPLOAD_ARCHIVE_DEFAULT_SUFFIX,
  uploadArchiveFormat,
} from "@scvs/core";
import { UploadsRepository } from "@scvs/db";

import { stagingUploadKey } from "../../common/upload-cleanup.js";
import type { ApiResponse } from "./submit.service.js";
import type { AppConfigService } from "../../config/configuration.js";
import { errorBody } from "@scvs/http";

@Injectable()
export class UploadsService {
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(UploadsRepository) private readonly uploads: UploadsRepository,
  ) {}

  async receive(body: Buffer, filenameHeader: string | undefined): Promise<ApiResponse> {
    if (!body.length) {
      return {
        statusCode: 400,
        body: errorBody(400, { error: "invalid_upload", message: "Upload body must contain a source archive." }),
      };
    }

    // From the bytes, never from the submitter-controlled `x-filename`.
    const format = uploadArchiveFormat(body);
    if (!format) {
      return {
        statusCode: 400,
        body: errorBody(400, {
          error: "source_archive_format_unsupported",
          message:
            `Source archive must be a gzip-compressed tarball or a zip (${ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES.join(", ")}); ` +
            "the uploaded bytes are neither.",
        }),
      };
    }

    const uploadId = uuidv4();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const sourceSha256 = createHash("sha256").update(body).digest("hex");
    const filename =
      sanitizeFilename(filenameHeader) || `${sourceSha256}${UPLOAD_ARCHIVE_DEFAULT_SUFFIX[format]}`;
    const stagingKey = stagingUploadKey(uploadId, filename);

    const staging = getStagingStorageConfig();
    const s3 = createS3Client({ region: staging.region });
    await putObjectBytes(s3, staging.bucket, stagingKey, body, UPLOAD_ARCHIVE_CONTENT_TYPE[format]);

    await this.uploads.createUpload({ id: uploadId, expiresAt });
    await this.uploads.markUploadReceived(uploadId, { path: stagingKey, filename, sizeBytes: body.length, sourceSha256 });

    return {
      statusCode: 201,
      body: {
        upload_id: uploadId,
        expires_at: expiresAt,
        max_size_bytes: this.configService.get("maxSourceArchiveBytes", { infer: true }),
        filename,
        size_bytes: body.length,
        source_sha256: sourceSha256,
      },
    };
  }
}

function sanitizeFilename(value?: string): string | undefined {
  if (!value) return undefined;
  const clean = basename(value).replace(/[^\w.\-+@]/g, "_");
  return clean || undefined;
}
