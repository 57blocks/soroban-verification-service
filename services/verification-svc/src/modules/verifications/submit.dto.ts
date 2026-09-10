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
  // `@AtLeastOneOf` lives on `network` (always validated), not on `contract_id`/`wasm_hash` (both
  // `@IsOptional()`).
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

  /** Accepted and never read. */
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  network_passphrase?: string;
}

export class SubmitRequestDto {
  /** `@IsDefined()` and `@IsObject()` are load-bearing, not belt-and-braces. */
  @ApiProperty({ type: SubmitTargetDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => SubmitTargetDto)
  target!: SubmitTargetDto;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  manifest?: unknown;

  /**
   * Return the verdict without publishing it: a real build and a real comparison, the answer handed back
   * through the job, and nothing written to the published result root.
   */
  @ApiPropertyOptional({ type: Boolean, default: false })
  @IsOptional()
  @IsBoolean()
  dry_run?: boolean;

  /**
   * The terms version the submitter accepted (TRD §8.1). `@IsOptional()` here and required in
   * `SubmitService`: the DTO cannot express "required only while the operator's document declares an
   * effective date", and a `ValidationPipe` rejection would surface as `invalid_request`, which is the one
   * thing the two terms codes must be distinguishable from.
   *
   * A request field rather than a header — the accepted version is not a secret, and orval's generated
   * client cannot send a header.
   */
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
  // Whole `target` key missing or not an object at all — old code's combined `!target || !target.network` check
  // produced the same message for this case too.
  const wholeTargetIssue = issues.find((issue) => issue.property === "target");
  if (wholeTargetIssue) {
    return { error: "invalid_request", message: "target.network must be 'mainnet' or 'testnet'", status_code: 400 };
  }
  const firstMessage = issues[0] ? Object.values(issues[0].constraints)[0] : undefined;
  return { error: "invalid_request", message: firstMessage ?? "Invalid request", status_code: 400 };
}

// ---------------------------------------------------------------------------
// POST /v1/verifications response variants. Moved out of the retired `@scvs/schema`; only this service produces
// them.

export class SubmitQueuedResponse {
  @ApiProperty({ enum: ["queued"] }) @Equals("queued") status!: "queued";
  @ApiProperty({ type: String }) @IsString() job_id!: string;
  @ApiProperty({ type: VerificationTarget }) @ValidateNested() @Type(() => VerificationTarget) target!: VerificationTarget;
  /**
   * Present only on the two paths that ran preflight to get here — the inferred-manifest submit and its
   * in-flight-job reuse arm (`submit.service.ts:189`, `:205`).
   */
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() available_fields?: Record<string, string>;
  /**
   * The one-time secret that reads this job's raw build log (build-log-access design.md BL-1). **Returned by
   * this response and by nothing else, ever** — store it if you want the log. Absent when this response hands
   * back a job an earlier submission created: that job's token went to whoever created it.
   */
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() build_log_token?: string;
  @ApiProperty({ type: String }) @IsString() message!: string;
}

export class SubmitIncompleteResponse {
  @ApiProperty({ enum: ["incomplete"] }) @Equals("incomplete") status!: "incomplete";
  @ApiProperty({ type: VerificationTarget }) @ValidateNested() @Type(() => VerificationTarget) target!: VerificationTarget;
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) missing_fields!: string[];
  @ApiProperty({ type: Object }) @IsObject() available_fields!: Record<string, string>;
  /** SEP-58 wording for the missing fields this service has a hint for (`SEP58_FIELD_HINTS`). */
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() field_hints?: Record<string, string>;
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() prefill?: Record<string, unknown>;
  @ApiProperty({ type: String }) @IsString() message!: string;
}

export type SubmitResponse = SubmitQueuedResponse | SubmitIncompleteResponse;

/**
 * The `POST /v1/verifications` **success** shapes, for `@ApiExtraModels` — they are referenced by `$ref` from
 * the per-status-code schemas below, never by name in an `@ApiResponse({ type })`.
 */
export const submitResponseVariants = [SubmitQueuedResponse, SubmitIncompleteResponse] as const;

/**
 * Every `queued` return is **202** — `respondToCreated`, the inferred-manifest path, and the in-flight-job
 * reuse arm — and `incomplete` is the only **200**.
 */
export function submitAcceptedSchema() {
  return { $ref: getSchemaPath(SubmitQueuedResponse) };
}

export function submitIncompleteSchema() {
  return { $ref: getSchemaPath(SubmitIncompleteResponse) };
}
