import { ResultStorageEnvDto } from "@scvs/config";
import { IsNotEmpty, IsNumberString, IsOptional } from "class-validator";

/** This service's environment contract, validated once at boot by `ConfigModule.forRoot({ validate })`. */
export class VerificationSvcEnvDto extends ResultStorageEnvDto {
  // Optional here on purpose, unlike orchestrator-svc's `@IsNotEmpty` on the same variable.
  @IsOptional() @IsNotEmpty({ message: "SCVS_STORAGE_BUCKET must not be empty when set" })
  SCVS_STORAGE_BUCKET?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_UPLOAD_RATE_LIMIT_PER_MINUTE must be a number" })
  SCVS_UPLOAD_RATE_LIMIT_PER_MINUTE?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_THROTTLE_LIMIT must be a number" })
  SCVS_THROTTLE_LIMIT?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_UPLOAD_CLEANUP_INTERVAL_MS must be a number" })
  SCVS_UPLOAD_CLEANUP_INTERVAL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS must be a number" })
  SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_MAX_SOURCE_ARCHIVE_BYTES must be a number" })
  SCVS_MAX_SOURCE_ARCHIVE_BYTES?: string;




  // The one variable in this DTO that is not optional: without it the abuse fingerprint would fall back to an
  // empty HMAC key, which is the reversible hash this replaced.
  @IsNotEmpty({ message: "SCVS_ABUSE_FINGERPRINT_KEY must be set — see docs/features/retention-and-pseudonymisation/design.md §5" })
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

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_STREAM_WINDOW_MS must be a number" })
  SCVS_JOB_STREAM_WINDOW_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_STREAM_SAFETY_POLL_MS must be a number" })
  SCVS_JOB_STREAM_SAFETY_POLL_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_JOB_MAX_WAIT_MS must be a number" })
  SCVS_JOB_MAX_WAIT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_ACTIVE_JOB_DEDUP_STALE_MS must be a number" })
  SCVS_ACTIVE_JOB_DEDUP_STALE_MS?: string;

  // The second non-optional in this DTO, for the same kind of reason as the first: there is no safe
  // fallback for an operator's legal text, so an unset value must stop the boot.
  @IsNotEmpty({ message: "SCVS_LEGAL_DOCUMENTS_SOURCE must be set — see docs/features/versioned-terms-and-assent/design.md TA-4" })
  SCVS_LEGAL_DOCUMENTS_SOURCE!: string;
}
