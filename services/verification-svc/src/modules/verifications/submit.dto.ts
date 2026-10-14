import { ApiProperty, ApiPropertyOptional, getSchemaPath } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { Equals, IsArray, IsBoolean, IsDefined, IsIn, IsObject, IsOptional, IsString, Matches, ValidateNested } from "class-validator";
import {
  AtLeastOneOf,
  flattenValidationErrors,
  LowercaseHex,
  networks,
  SEP58_HEX_SHA256,
  VerificationTarget,
  type Network,
  type ValidationError,
} from "@scvs/core";

export class SubmitTargetDto {
  // `@AtLeastOneOf` sits on `network`: `@IsOptional()` would skip it on `contract_id`/`wasm_hash`.
  @ApiProperty({ enum: networks })
  @IsIn(networks)
  @AtLeastOneOf(["contract_id", "wasm_hash"])
  network!: Network;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  contract_id?: string;

  /** `@LowercaseHex()` runs inside `plainToInstance` — i.e. before `@Matches`. */
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @LowercaseHex()
  @Matches(SEP58_HEX_SHA256, {
    message: "target.wasm_hash must be a 64-character hex Wasm hash",
  })
  wasm_hash?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  network_passphrase?: string;
}

/** The request's shape only: `validateSubmittedManifest` is what enforces it. */
export class SubmissionManifest {
  @ApiProperty({ enum: ["stellar-submitted-source-verification-manifest-v1"] })
  schema!: string;

  @ApiProperty({ type: String, pattern: "^[0-9a-fA-F]{64}$", description: "SHA-256 of the exact source archive bytes." })
  source_sha256!: string;

  @ApiPropertyOptional({ type: String, format: "uri", description: "Where the verifier fetches the archive. Give this or `upload_id`." })
  source_uri?: string;

  @ApiPropertyOptional({ type: String, format: "uuid", description: "The `upload_id` of an upload. Give this or `source_uri`." })
  upload_id?: string;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description: "Whether the verifier keeps the source and serves it with the result.",
  })
  is_public?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: "Options for `stellar contract build`. Leave unset to use what the contract records.",
  })
  bldopt?: string[];

  @ApiPropertyOptional({ type: [String], description: "Build arguments. Leave unset to use what the contract records." })
  bldarg?: string[];

  @ApiPropertyOptional({
    type: String,
    deprecated: true,
    description: "Not used to choose the build environment, which comes from the deployed contract. Kept for older clients.",
  })
  bldimg?: string;
}

export class SubmitRequestDto {
  /** `@IsDefined()` and `@IsObject()` are load-bearing. */
  @ApiProperty({ type: SubmitTargetDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => SubmitTargetDto)
  target!: SubmitTargetDto;

  @ApiPropertyOptional({ type: SubmissionManifest })
  @IsOptional()
  manifest?: unknown;

  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;

  /** Enforced in `SubmitService`: a DTO rejection would read as `invalid_request`, not a terms code. */
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  accepted_terms_version?: string;
}

export function mapSubmitIssues(errors: ValidationError[]) {
  const issues = flattenValidationErrors(errors);
  const networkIssue = issues.find((issue) => issue.constraints.isIn);
  if (networkIssue) {
    return { error: "invalid_request", message: "target.network must be 'mainnet' or 'testnet'", status_code: 400 };
  }
  const missingTargetIssue = issues.find((issue) => issue.constraints.atLeastOneOf);
  if (missingTargetIssue) {
    return { error: "invalid_request", message: "target must include contract_id or wasm_hash", status_code: 400 };
  }
  const wholeTargetIssue = issues.find((issue) => issue.property === "target");
  if (wholeTargetIssue) {
    return { error: "invalid_request", message: "target.network must be 'mainnet' or 'testnet'", status_code: 400 };
  }
  const firstMessage = issues[0] ? Object.values(issues[0].constraints)[0] : undefined;
  return { error: "invalid_request", message: firstMessage ?? "Invalid request", status_code: 400 };
}

export class SubmitQueuedResponse {
  @ApiProperty({ enum: ["queued"] }) @Equals("queued") status!: "queued";
  @ApiProperty({ type: String }) @IsString() job_id!: string;
  @ApiProperty({ type: VerificationTarget }) @ValidateNested() @Type(() => VerificationTarget) target!: VerificationTarget;
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() available_fields?: Record<string, string>;
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() build_log_token?: string;
  @ApiProperty({ type: String }) @IsString() message!: string;
}

export class SubmitIncompleteResponse {
  @ApiProperty({ enum: ["incomplete"] }) @Equals("incomplete") status!: "incomplete";
  @ApiProperty({ type: VerificationTarget }) @ValidateNested() @Type(() => VerificationTarget) target!: VerificationTarget;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) missing_fields!: string[];
  @ApiProperty({ type: Object }) @IsObject() available_fields!: Record<string, string>;
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() field_hints?: Record<string, string>;
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() prefill?: Record<string, unknown>;
  @ApiProperty({ type: String }) @IsString() message!: string;
}

export type SubmitResponse = SubmitQueuedResponse | SubmitIncompleteResponse;

export const submitResponseVariants = [SubmitQueuedResponse, SubmitIncompleteResponse] as const;

export function submitAcceptedSchema() {
  return { $ref: getSchemaPath(SubmitQueuedResponse) };
}

export function submitIncompleteSchema() {
  return { $ref: getSchemaPath(SubmitIncompleteResponse) };
}
