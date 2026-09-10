import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, ValidateNested } from "class-validator";
import {
  verificationStatuses,
  VerificationResultSummary,
  VerificationTarget,
  type VerificationStatus,
} from "@scvs/core";

// Response shapes owned by this service's job/upload routes. Moved out of the retired `@scvs/schema`.

export class JobProgress {
  @ApiProperty({ type: String }) @IsString() step!: string;
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() detail?: string;
}

// GET /v1/verifications/:job_id
/**
 * The minimized diagnostic layer's availability block (build-log-access design.md BL-6). It says whether a
 * raw log exists and until when — and deliberately carries **no captured output**, because this is the
 * response any visitor to a shared job link receives.
 */
export class BuildLogAvailability {
  @ApiProperty({ enum: ["none", "available", "expired"] })
  @IsIn(["none", "available", "expired"])
  state!: "none" | "available" | "expired";
  /** True wherever a log exists: the job id alone authorises nothing. */
  @ApiProperty({ type: Boolean }) @IsBoolean() requires_token!: boolean;
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() expires_at?: string;
}

export class JobStatusResponse {
  @ApiProperty({ type: String }) @IsString() job_id!: string;
  @ApiProperty({ enum: verificationStatuses }) @IsIn(verificationStatuses) status!: VerificationStatus;
  @ApiProperty({ type: String }) @IsString() created_at!: string;
  @ApiProperty({ type: String }) @IsString() updated_at!: string;
  /** When the job reached a terminal status. Read this, not `updated_at`, for anything time-based. */
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() completed_at?: string;
  @ApiProperty({ type: VerificationTarget }) @ValidateNested() @Type(() => VerificationTarget) target!: VerificationTarget;
  @ApiPropertyOptional({ type: VerificationResultSummary })
  @IsOptional()
  @ValidateNested()
  @Type(() => VerificationResultSummary)
  result?: VerificationResultSummary;
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() error?: string;
  @ApiPropertyOptional({ type: JobProgress })
  @IsOptional()
  @ValidateNested()
  @Type(() => JobProgress)
  progress?: JobProgress;
  @ApiProperty({ type: BuildLogAvailability })
  @ValidateNested()
  @Type(() => BuildLogAvailability)
  build_log!: BuildLogAvailability;
}

/**
 * GET /v1/verifications/:job_id/log, 404 — mirrors what `jobs.service.ts`'s `getBuildLog()` passes to
 * `errorBody()`, envelope included.
 */
export class BuildLogUnavailableResponse {
  @ApiProperty({ type: String }) @IsString() schema_version!: string;
  @ApiProperty({ type: Number }) @IsNumber() status_code!: number;
  @ApiProperty({ type: String }) @IsString() error!: string;
  @ApiProperty({ type: String }) @IsString() message!: string;
  // The *external* `VerificationStatus`, same vocabulary as `JobStatusResponse.status` above — not the internal
  // `JobStatus`.
  @ApiPropertyOptional({ enum: verificationStatuses })
  @IsOptional()
  @IsIn(verificationStatuses)
  job_status?: VerificationStatus;
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() failure_reason?: string;
}

// POST /v1/uploads/source — mirrors the object literal `uploads.service.ts`'s `receive()` returns.
export class UploadSourceResponse {
  @ApiProperty({ type: String }) @IsString() upload_id!: string;
  @ApiProperty({ type: String }) @IsString() expires_at!: string;
  @ApiProperty({ type: Number }) @IsNumber() max_size_bytes!: number;
  @ApiProperty({ type: String }) @IsString() filename!: string;
  @ApiProperty({ type: Number }) @IsNumber() size_bytes!: number;
  @ApiProperty({ type: String }) @IsString() source_sha256!: string;
}
