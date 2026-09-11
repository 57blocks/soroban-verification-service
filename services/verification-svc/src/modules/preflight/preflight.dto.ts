import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  AtLeastOneOf,
  flattenValidationErrors,
  LowercaseHex,
  networks,
  SEP58_HEX_SHA256,
  SubmittedSourceManifest,
  VerificationTarget,
  type Network,
  type ValidationError,
} from "@scvs/core";
import {
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from "class-validator";

/**
 * Composes `@scvs/core`'s `networks`/`Network` (the shared, single-source-of-truth field type) with a
 * request-local `@AtLeastOneOf` for the "need at least one of contract_id/wasm_hash" rule.
 */
export class PreflightRequestDto {
  // `@AtLeastOneOf` lives here, not on `contract_id`/`wasm_hash` themselves, because `@IsOptional()` on a
  // property makes `class-validator` skip *every* decorator on that same property (not just its own type check)
  // whenever the value is missing.
  @ApiProperty({ enum: networks })
  @IsIn(networks)
  @AtLeastOneOf(["contract_id", "wasm_hash"])
  network!: Network;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  contract_id?: string;

  /** Normalised and shape-checked exactly as `SubmitTargetDto`'s — see its note on the same field. */
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @LowercaseHex()
  @Matches(SEP58_HEX_SHA256, {
    message: "target.wasm_hash must be a 64-character hex Wasm hash",
  })
  wasm_hash?: string;

  /** Accepted and never read — see `SubmitTargetDto`'s note on the same field. */
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  network_passphrase?: string;
}

/**
 * Reshapes `class-validator` errors into the exact error body the old hand-rolled `if` checks (and, before
 * that, the Zod-based `ZodBodyPipe`) returned.
 */
export function mapPreflightIssues(errors: ValidationError[]) {
  const issues = flattenValidationErrors(errors);
  const networkIssue = issues.find((issue) => issue.constraints.isIn);
  if (networkIssue) {
    return {
      error: "invalid_network",
      message: "network must be 'mainnet' or 'testnet'",
      status_code: 400,
    };
  }
  const missingTargetIssue = issues.find(
    (issue) => issue.constraints.atLeastOneOf,
  );
  if (missingTargetIssue) {
    return {
      error: "missing_target",
      message: "Either contract_id or wasm_hash is required",
      status_code: 400,
    };
  }
  const firstMessage = issues[0]
    ? Object.values(issues[0].constraints)[0]
    : undefined;
  return {
    error: "invalid_request",
    message: firstMessage ?? "Invalid request",
    status_code: 400,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/preflight response. Moved out of the retired `@scvs/schema`; only this service produces it.

/**
 * `PreflightBuildEnvironment`'s four arms as OpenAPI schemas: `@scvs/core`'s `BuildEnvironmentResolution` plus
 * `build-environment.ts`'s preflight-only `chain_named_policy_rejected`.
 */
// Typed through `ApiProperty`'s own parameter rather than by importing `SchemaObject`: that type lives behind
// @nestjs/swagger's `exports` map and is not re-exported from the package root, and the annotation is what
// makes TypeScript read the literals below as the narrow strings the schema type wants instead of widening them
// to `string`.
const buildEnvironmentSchema: Parameters<typeof ApiProperty>[0] = {
  // `type` is the `Object` constructor, not the string: without it @nestjs/swagger reflects this property's
  // TypeScript type, fails to resolve `Record<string, unknown>` to a model, and reports a false circular
  // dependency.
  type: Object,
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["chain_named"] },
        image: { type: "string" },
        trustLevel: { type: "string", enum: ["sdf_trusted"] },
      },
      required: ["kind", "image", "trustLevel"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["compose"] },
        intent: { type: "object" },
        trustLevel: { type: "string", enum: ["upstream_pinned"] },
      },
      required: ["kind", "intent", "trustLevel"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["unsupported"] },
        reason: {
          type: "string",
          enum: ["unreleased_cli", "undated_nightly", "missing_toolchain_pair"],
        },
      },
      required: ["kind", "reason"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["chain_named_policy_rejected"] },
        reason: {
          type: "string",
          enum: ["image_not_digest_pinned", "image_not_sdf_trusted"],
        },
        detail: { type: "string" },
      },
      required: ["kind", "reason", "detail"],
    },
  ],
};

export class PreflightMetadata {
  @ApiProperty({ type: Object }) @IsObject() available!: Record<string, string>;
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  missing!: string[];
}

export class PreflightResponse {
  @ApiProperty({ type: VerificationTarget })
  @ValidateNested()
  @Type(() => VerificationTarget)
  target!: VerificationTarget;
  @ApiProperty({ type: String }) @IsString() wasm_hash!: string;
  @ApiProperty({ type: Number }) @IsNumber() wasm_byte_size!: number;
  @ApiProperty({ type: PreflightMetadata })
  @ValidateNested()
  @Type(() => PreflightMetadata)
  metadata!: PreflightMetadata;
  // Duplicates `metadata.available`/`metadata.missing` under snake_case top-level keys.
  @ApiProperty({ type: Object }) @IsObject() available_fields!: Record<
    string,
    string
  >;
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  missing_fields!: string[];
  @ApiPropertyOptional({ type: SubmittedSourceManifest, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => SubmittedSourceManifest)
  suggested_manifest!: Partial<SubmittedSourceManifest> | null;
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  prefill?: Record<string, unknown>;
  // `PreflightBuildEnvironment` (build-environment.ts) is a discriminated union, not a class, so the TypeScript
  // side stays loose here the same way `available_fields`/`prefill` are, rather than inventing a
  // `class-validator` hierarchy for a classification-only response.
  @ApiProperty(buildEnvironmentSchema) @IsObject() build_environment!: Record<
    string,
    unknown
  >;
}
