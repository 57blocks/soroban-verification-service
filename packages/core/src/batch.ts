import { SchemaHint } from "./schema-hint.js";
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, Matches, ValidateIf, ValidateNested } from "class-validator";
import { buildModes, type BuildMode } from "./enums.js";
import { SandboxDiagnostics } from "./result.js";
import { BuildRecipe, sourceReferenceDiscriminator, type SourceReference } from "./source.js";
import { VerificationTarget } from "./target.js";
import { HEX_SHA256 } from "./digest.js";

export class BatchJobParams {
  @IsString() job_id!: string;
  @ValidateNested() @Type(() => VerificationTarget) target!: VerificationTarget;
  @ValidateNested()
  @Type(() => Object, { discriminator: sourceReferenceDiscriminator, keepDiscriminatorProperty: true })
  source_ref!: SourceReference;
  /** A full `registry/repo@sha256:<hex>` reference, not a bare digest. */
  @Matches(/^[^\s@/]*[.:][^\s@/]*\/[^\s@]+@sha256:[0-9a-f]{64}$/) image_digest!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) build_args?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) build_options?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) metadata_replay?: string[];
  @IsIn(buildModes) mode!: BuildMode;
  @IsString() upload_url!: string;
  @IsString() artifact_upload_url!: string;
}

export class MaterialiseJobParams {
  @IsString() job_id!: string;
  @ValidateNested()
  @Type(() => Object, { discriminator: sourceReferenceDiscriminator, keepDiscriminatorProperty: true })
  source_ref!: SourceReference;
  @IsIn(buildModes) mode!: BuildMode;
  @IsOptional() @Matches(HEX_SHA256) expected_source_sha256?: string;
  @IsOptional() @IsString() canonical_source_upload_url?: string;
}

export class SourceCanonicalisation {
  @IsNumber() depth!: number;
  @IsString() outer_format!: string;
  @IsString() canonical_format!: string;
  @IsOptional() @Matches(HEX_SHA256) canonical_sha256?: string;
  @IsOptional() @Matches(HEX_SHA256) expected_source_sha256?: string;
  @IsIn(["not_attempted", "no_oracle", "adopted", "hash_mismatch", "failed"])
  reconstruction!: "not_attempted" | "no_oracle" | "adopted" | "hash_mismatch" | "failed";
  @IsOptional() @IsString() reconstruction_detail?: string;
  @IsBoolean() uploaded!: boolean;
}

const buildArtifactClassifications = ["success", "comparison_mismatch", "cli_failure"] as const;
const buildArtifactRunners = ["stellar_contract_verify", "docker_build_image_rebuild"] as const;

export class BuildArtifact {
  @IsOptional() @IsString() schema_version?: string;
  @ValidateNested() @Type(() => BuildRecipe) recipe!: BuildRecipe;
  @IsIn(buildArtifactRunners) runner!: (typeof buildArtifactRunners)[number];
  @IsString() built_at!: string;
  @SchemaHint({ nullable: true })
  @ValidateIf((_o, v) => v !== null)
  @IsNumber()
  exit_code!: number | null;
  @IsIn(buildArtifactClassifications) classification!: (typeof buildArtifactClassifications)[number];
  @IsOptional() @IsString() rebuilt_wasm_hash?: string;
  @IsOptional() @IsNumber() rebuilt_wasm_size_bytes?: number;
  @IsOptional() @IsString() build_log?: string;
  @IsOptional() @IsString() source_sha256?: string;
  @IsOptional() @ValidateNested() @Type(() => SourceCanonicalisation)
  source_canonicalisation?: SourceCanonicalisation;
  @IsOptional() @IsString() verify_attempt_reason?: string;
  @IsOptional() @IsBoolean() rebuilt_wasm_uploaded?: boolean;
  @IsOptional() @ValidateNested() @Type(() => SandboxDiagnostics) diagnostics?: SandboxDiagnostics;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsObject() failure_context?: Record<string, unknown>;
}
