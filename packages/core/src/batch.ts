import { SchemaHint } from "./schema-hint.js";
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, Matches, ValidateIf, ValidateNested } from "class-validator";
import { buildModes, type BuildMode } from "./enums.js";
import { SandboxDiagnostics } from "./result.js";
import { BuildRecipe, sourceReferenceDiscriminator, type SourceReference } from "./source.js";
import { VerificationTarget } from "./target.js";

// The orchestrator↔builder wire contract.

// What the **runner** container receives. Internal message-passing shape only — never a Nest HTTP body — so no
// `@ApiProperty` here.
export class BatchJobParams {
  @IsString() job_id!: string;
  @ValidateNested() @Type(() => VerificationTarget) target!: VerificationTarget;
  @ValidateNested()
  @Type(() => Object, { discriminator: sourceReferenceDiscriminator, keepDiscriminatorProperty: true })
  source_ref!: SourceReference;
  /** NOT a bare digest, despite the name. */
  @Matches(/^[^\s@/]*[.:][^\s@/]*\/[^\s@]+@sha256:[0-9a-f]{64}$/) image_digest!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) build_args?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) build_options?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) metadata_replay?: string[];
  @IsIn(buildModes) mode!: BuildMode;
  // `SCVS_MAINNET_RPC_URL` itself is untouched; the two chain readers that still spawn the CLI are resident
  // services, not this document's reader.
  @IsString() upload_url!: string;
  /** Presigned PUT for the rebuilt Wasm bytes themselves. */
  @IsString() artifact_upload_url!: string;
}

/** What the **materialiser** container receives — the three fields it reads, and no others. */
export class MaterialiseJobParams {
  @IsString() job_id!: string;
  @ValidateNested()
  @Type(() => Object, { discriminator: sourceReferenceDiscriminator, keepDiscriminatorProperty: true })
  source_ref!: SourceReference;
  @IsIn(buildModes) mode!: BuildMode;
  /** The `source_sha256` the deployed Wasm's `contractmetav0` records, when it records one. */
  @IsOptional() @Matches(/^[0-9a-f]{64}$/) expected_source_sha256?: string;
  /**
   * Presigned PUT for the canonical source archive's bytes — used only when they are not the bytes the trusted
   * side already holds, i.e. a container was peeled or a rebuilt archive was adopted.
   */
  @IsOptional() @IsString() canonical_source_upload_url?: string;
}

/**
 * What the materialiser did to get from the submitted bytes to the archive it built from — the peel, and
 * whether a rebuilt archive was adopted.
 */
export class SourceCanonicalisation {
  /** 0 means the submitted bytes were already the canonical archive — every ordinary submission. */
  @IsNumber() depth!: number;
  @IsString() outer_format!: string;
  @IsString() canonical_format!: string;
  @IsOptional() @Matches(/^[0-9a-f]{64}$/) canonical_sha256?: string;
  /** `MaterialiseJobParams.expected_source_sha256` echoed back. */
  @IsOptional() @Matches(/^[0-9a-f]{64}$/) expected_source_sha256?: string;
  /** `no_oracle` — the contract records no `source_sha256`, so nothing could be checked against. */
  @IsIn(["not_attempted", "no_oracle", "adopted", "hash_mismatch", "failed"])
  reconstruction!: "not_attempted" | "no_oracle" | "adopted" | "hash_mismatch" | "failed";
  /** Why, when `reconstruction` is `hash_mismatch` or `failed`. */
  @IsOptional() @IsString() reconstruction_detail?: string;
  /** Whether the canonical bytes were uploaded. False means "canonical == what you already hold". */
  @IsBoolean() uploaded!: boolean;
}

const buildArtifactClassifications = ["success", "comparison_mismatch", "cli_failure"] as const;
const buildArtifactRunners = ["stellar_contract_verify", "docker_build_image_rebuild"] as const;

// recipe.json.
export class BuildArtifact {
  /**
   * `MAJOR.MINOR` of this document's shape — `BUILD_ARTIFACT_SCHEMA_VERSION`, on every artifact
   * `buildRecipeArtifact` writes.
   */
  @IsOptional() @IsString() schema_version?: string;
  @ValidateNested() @Type(() => BuildRecipe) recipe!: BuildRecipe;
  @IsIn(buildArtifactRunners) runner!: (typeof buildArtifactRunners)[number];
  @IsString() built_at!: string;
  @SchemaHint({ nullable: true })
  @ValidateIf((_o, v) => v !== null)
  @IsNumber()
  exit_code!: number | null;
  // Baked in at build time (services/builder's `classifyRunCliOutcome`) so a consumer that only ever sees this
  // artifact.
  @IsIn(buildArtifactClassifications) classification!: (typeof buildArtifactClassifications)[number];
  /**
   * `RebuildOutcomeService` fetches the bytes from `artifact_upload_url`'s key, hashes them itself, and records
   * *that* as the rebuild's `rebuilt_wasm_hash`.
   */
  @IsOptional() @IsString() rebuilt_wasm_hash?: string;
  @IsOptional() @IsNumber() rebuilt_wasm_size_bytes?: number;
  /** Carrying the text here costs zero override bytes and adds no output channel. */
  @IsOptional() @IsString() build_log?: string;
  /** orchestrator-svc cross-checks it against `job.sourceRef.source_sha256`. */
  @IsOptional() @IsString() source_sha256?: string;
  /**
   * How the archive the sandbox built from relates to the bytes that were submitted — absent when they are the
   * same thing, which is every submission that is not a container around an archive.
   */
  @IsOptional() @ValidateNested() @Type(() => SourceCanonicalisation)
  source_canonicalisation?: SourceCanonicalisation;
  /**
   * The `verify` attempt's own failure code, set when the runner was dispatched in `verify` mode, established
   * before invoking the CLI that it could not succeed, and ran the sandboxed rebuild itself instead of burning
   * a second Batch job.
   */
  @IsOptional() @IsString() verify_attempt_reason?: string;
  /** Whether the runner's rebuilt-Wasm PUT actually succeeded. */
  @IsOptional() @IsBoolean() rebuilt_wasm_uploaded?: boolean;
  @IsOptional() @ValidateNested() @Type(() => SandboxDiagnostics) diagnostics?: SandboxDiagnostics;
  /**
   * The builder's own machine-readable failure code — `manifest_path_not_found`, `dependency_prefetch_failed`,
   * `sandbox_unavailable`, … — set whenever `classification === "cli_failure"`.
   */
  @IsOptional() @IsString() reason?: string;
  /** Small, unstructured context for `reason` — resolved paths, a `detail` sentence. */
  @IsOptional() @IsObject() failure_context?: Record<string, unknown>;
}
