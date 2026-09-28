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

export class PreflightRequestDto {
  // Here, not on the optional fields: `@IsOptional()` skips every decorator on its property when the value is missing.
  @ApiProperty({ enum: networks })
  @IsIn(networks)
  @AtLeastOneOf(["contract_id", "wasm_hash"])
  network!: Network;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  contract_id?: string;

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

// Typed via `ApiProperty`'s parameter: `SchemaObject` is not a root export, and this keeps the literals narrow.
const buildEnvironmentSchema: Parameters<typeof ApiProperty>[0] = {
  // The `Object` constructor, not the string: otherwise @nestjs/swagger reports a false circular dependency.
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
  @ApiProperty(buildEnvironmentSchema) @IsObject() build_environment!: Record<
    string,
    unknown
  >;
}
