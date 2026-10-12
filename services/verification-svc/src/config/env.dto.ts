import { ResultStorageEnvDto } from "@scvs/config";
import { IsNotEmpty, IsNumberString, IsOptional, Matches } from "class-validator";

export class VerificationSvcEnvDto extends ResultStorageEnvDto {
  // Optional: preflight, submit and the job-status routes must serve without a staging bucket.
  @IsOptional() @IsNotEmpty({ message: "SCVS_STORAGE_BUCKET must not be empty when set" })
  SCVS_STORAGE_BUCKET?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_UPLOAD_RATE_LIMIT_PER_MINUTE must be a number" })
  SCVS_UPLOAD_RATE_LIMIT_PER_MINUTE?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_THROTTLE_LIMIT must be a number" })
  SCVS_THROTTLE_LIMIT?: string;

  @IsOptional()
  @Matches(/^[1-9]\d*$/, {
    message: "SCVS_READ_THROTTLE_LIMIT must be a positive whole number of requests per minute",
  })
  SCVS_READ_THROTTLE_LIMIT?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_UPLOAD_CLEANUP_INTERVAL_MS must be a number" })
  SCVS_UPLOAD_CLEANUP_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS must be a number" })
  SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_MAX_SOURCE_ARCHIVE_BYTES must be a number" })
  SCVS_MAX_SOURCE_ARCHIVE_BYTES?: string;




  @IsNotEmpty({ message: "SCVS_ABUSE_FINGERPRINT_KEY must be set — it is the HMAC key rate-limit fingerprints are computed under (config/env-manifest.yaml)" })
  SCVS_ABUSE_FINGERPRINT_KEY!: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_ABUSE_COUNTER_RETENTION_MS must be a number" })
  SCVS_ABUSE_COUNTER_RETENTION_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_ABUSE_SWEEP_INTERVAL_MS must be a number" })
  SCVS_ABUSE_SWEEP_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_ABUSE_WINDOW_MS must be a number" })
  SCVS_ABUSE_WINDOW_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_ABUSE_MAX_PER_WINDOW must be a number" })
  SCVS_ABUSE_MAX_PER_WINDOW?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW must be a number" })
  SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_STREAM_ABUSE_MAX_PER_WINDOW must be a number" })
  SCVS_STREAM_ABUSE_MAX_PER_WINDOW?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_ABUSE_FAILOPEN_THRESHOLD must be a number" })
  SCVS_ABUSE_FAILOPEN_THRESHOLD?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_STREAM_WINDOW_MS must be a number" })
  SCVS_JOB_STREAM_WINDOW_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_STREAM_SAFETY_POLL_MS must be a number" })
  SCVS_JOB_STREAM_SAFETY_POLL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_STREAM_MAX_CONNECTIONS_PER_JOB must be a number" })
  SCVS_JOB_STREAM_MAX_CONNECTIONS_PER_JOB?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_STREAM_MAX_CONNECTIONS_PER_IP must be a number" })
  SCVS_JOB_STREAM_MAX_CONNECTIONS_PER_IP?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_STREAM_MAX_CONNECTIONS_TOTAL must be a number" })
  SCVS_JOB_STREAM_MAX_CONNECTIONS_TOTAL?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_MAX_WAIT_MS must be a number" })
  SCVS_JOB_MAX_WAIT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_ACTIVE_JOB_DEDUP_STALE_MS must be a number" })
  SCVS_ACTIVE_JOB_DEDUP_STALE_MS?: string;

  @IsNotEmpty({ message: "SCVS_LEGAL_DOCUMENTS_SOURCE must be set: a bundle's path or https: URL, or the bundle itself" })
  SCVS_LEGAL_DOCUMENTS_SOURCE!: string;
}
