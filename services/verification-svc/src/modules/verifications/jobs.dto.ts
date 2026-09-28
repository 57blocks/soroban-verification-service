import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, ValidateNested } from "class-validator";
import {
  verificationStatuses,
  VerificationResultSummary,
  VerificationTarget,
  type VerificationStatus,
} from "@scvs/core";

export class JobProgress {
  @ApiProperty({ type: String }) @IsString() step!: string;
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() detail?: string;
}

export class BuildLogAvailability {
  @ApiProperty({ enum: ["none", "available", "expired"] })
  @IsIn(["none", "available", "expired"])
  state!: "none" | "available" | "expired";
  @ApiProperty({ type: Boolean }) @IsBoolean() requires_token!: boolean;
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() expires_at?: string;
}

export class JobStatusResponse {
  @ApiProperty({ type: String }) @IsString() job_id!: string;
  @ApiProperty({ enum: verificationStatuses }) @IsIn(verificationStatuses) status!: VerificationStatus;
  @ApiProperty({ type: String }) @IsString() created_at!: string;
  @ApiProperty({ type: String }) @IsString() updated_at!: string;
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

export class BuildLogUnavailableResponse {
  @ApiProperty({ type: String }) @IsString() schema_version!: string;
  @ApiProperty({ type: Number }) @IsNumber() status_code!: number;
  @ApiProperty({ type: String }) @IsString() error!: string;
  @ApiProperty({ type: String }) @IsString() message!: string;
  @ApiPropertyOptional({ enum: verificationStatuses })
  @IsOptional()
  @IsIn(verificationStatuses)
  job_status?: VerificationStatus;
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() failure_reason?: string;
}

export class UploadSourceResponse {
  @ApiProperty({ type: String }) @IsString() upload_id!: string;
  @ApiProperty({ type: String }) @IsString() expires_at!: string;
  @ApiProperty({ type: Number }) @IsNumber() max_size_bytes!: number;
  @ApiProperty({ type: String }) @IsString() filename!: string;
  @ApiProperty({ type: Number }) @IsNumber() size_bytes!: number;
  @ApiProperty({ type: String }) @IsString() source_sha256!: string;
}
