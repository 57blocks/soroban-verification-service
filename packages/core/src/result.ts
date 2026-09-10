import { SchemaHint } from "./schema-hint.js";
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { verificationStatuses, type VerificationStatus } from "./enums.js";

// Shared result/diagnostics domain model.

export class WasmSection {
  @IsNumber() id!: number;
  @IsString() name!: string;
  @IsNumber() size_bytes!: number;
  @IsOptional() @IsNumber() count?: number;
  @IsOptional() @IsString() custom_name?: string;
}

export class WasmSectionDiff {
  @IsString() key!: string;
  @IsOptional() @IsNumber() deployed?: number;
  @IsOptional() @IsNumber() rebuilt?: number;
}

export class WasmSummary {
  @IsNumber() size_bytes!: number;
  @IsOptional() @IsNumber() section_count?: number;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WasmSection)
  sections?: WasmSection[];
  @IsOptional() @IsArray() @IsString({ each: true }) custom_sections?: string[];
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  soroban_custom_sections?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) imports?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) exports?: string[];
  @IsOptional() @IsNumber() type_count?: number;
  @IsOptional() @IsNumber() function_count?: number;
  @IsOptional() @IsNumber() code_count?: number;
}

export class ImportExportDiff {
  @IsArray() @IsString({ each: true }) only_deployed!: string[];
  @IsArray() @IsString({ each: true }) only_rebuilt!: string[];
}

export class CustomSectionDiff extends ImportExportDiff {
  @IsArray() @IsString({ each: true }) common!: string[];
}

export class WasmParseErrors {
  @IsOptional() @IsString() deployed?: string;
  @IsOptional() @IsString() rebuilt?: string;
}

export class WasmComparisonDiagnostics {
  @IsOptional() @ValidateNested() @Type(() => WasmSummary) deployed?: WasmSummary;
  @IsOptional() @ValidateNested() @Type(() => WasmSummary) rebuilt?: WasmSummary;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WasmSectionDiff)
  section_diffs?: WasmSectionDiff[];
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomSectionDiff)
  custom_section_diff?: CustomSectionDiff;
  @IsOptional()
  @ValidateNested()
  @Type(() => ImportExportDiff)
  import_diff?: ImportExportDiff;
  @IsOptional()
  @ValidateNested()
  @Type(() => ImportExportDiff)
  export_diff?: ImportExportDiff;
  @IsOptional()
  @ValidateNested()
  @Type(() => WasmParseErrors)
  parse_errors?: WasmParseErrors;
}

const sandboxRunners = ["stellar_contract_verify", "docker_build_image_rebuild"] as const;

export class ReferenceAlignmentCommit {
  @IsNumber() pr!: number;
  @IsString() sha!: string;
}

/** Which upstream `stellar` the sandbox's reference was aligned to, read off `docker/stellar-cli.pin`. */
export class ReferenceAlignmentDto {
  @IsIn(["stellar/stellar-cli"]) repo!: "stellar/stellar-cli";
  /** The pinned official release tag, e.g. `v28.0.0`. */
  @IsOptional() @IsString() version?: string;
  /** Present on artifacts written before it, absent after. */
  @IsOptional() @IsString() base_commit?: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReferenceAlignmentCommit)
  pr_commits?: ReferenceAlignmentCommit[];
  @IsIn(["docker/stellar-cli.pin"])
  read_from!: "docker/stellar-cli.pin";
}

// Emitted by services/builder (run-cli.ts / recipe.ts) and consumed by services/orchestrator-svc/src/publish
// (compare.ts / build-result.ts) as part of the published VerificationResultSummary.
export class SandboxDiagnostics {
  @IsIn(sandboxRunners) runner!: (typeof sandboxRunners)[number];
  @IsOptional() @IsString() build_image?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) command?: string[];
  @IsOptional() @IsString() command_summary?: string;
  @IsOptional() @IsString() source_mount?: string;
  @IsOptional() @IsString() output_mount?: string;
  @IsOptional() @IsString() cargo_target_dir?: string;
  @IsOptional() @IsString() tmp_dir?: string;
  @IsOptional() @IsString() manifest_path?: string;
  @IsOptional() @IsString() container_manifest_path?: string;
  @IsOptional() @IsString() expected_wasm_hash?: string;
  @IsOptional() @IsString() rebuilt_wasm_hash?: string;
  @IsOptional() @IsNumber() rebuilt_wasm_size_bytes?: number;
  @IsOptional() @IsBoolean() docker_available?: boolean;
  @IsOptional() @IsString() docker_error?: string;
  @IsOptional() @IsString() docker_cpus?: string;
  @IsOptional() @IsString() docker_memory?: string;
  @IsOptional() @IsString() docker_pids_limit?: string;
  @IsOptional() @IsString() docker_cap_drop?: string;
  @IsOptional() @IsString() docker_security_opt?: string;
  @IsOptional() @IsString() docker_network?: string;
  @IsOptional() @IsBoolean() docker_read_only?: boolean;
  @IsOptional() @IsString() docker_user?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) docker_tmpfs?: string[];
  @IsOptional() @IsIn(["cargo_vendor"]) dependency_prefetch?: "cargo_vendor";
  @IsOptional() @IsString() dependency_vendor_dir?: string;
  @SchemaHint({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber()
  dependency_prefetch_exit_code?: number | null;
  @IsOptional() @IsIn(["allowlist"]) dependency_prefetch_policy?: "allowlist";
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dependency_prefetch_allowed_hosts?: string[];
  @IsOptional() @IsString() dependency_prefetch_blocked_url?: string;
  @IsOptional() @IsString() cargo_home?: string;
  @IsOptional() @IsBoolean() cargo_net_offline?: boolean;
  /**
   * Where the vendored-sources/offline config was written. Kept out of the submitted source tree so the build
   * never mutates the bytes that `source_sha256` describes, and so a project's own `.cargo/config.toml`.
   */
  @IsOptional() @IsString() cargo_config_path?: string;
  /** The toolchain pinned via `RUSTUP_TOOLCHAIN`, probed from the digest-pinned build image. */
  @IsOptional() @IsString() rustup_toolchain?: string;
  @IsOptional() @IsBoolean() toolchain_pinned?: boolean;
  /**
   * Set when the submitted source carries a `rust-toolchain`/`rust-toolchain.toml` file — the case where a
   * failed toolchain probe is fatal rather than merely unpinned.
   */
  @IsOptional() @IsString() source_rust_toolchain_file?: string;
  /** `bldopt` tokens the rebuild did not replay and does not re-issue itself. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  unreplayed_bldopts?: string[];
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  replayed_bldopts?: string[];
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  unparsable_bldopts?: string[];
  /**
   * The one build-command argument the image's CLI rejected, when it named one. **The flag only, never its
   * value**.
   */
  @IsOptional() @IsString() rejected_build_option?: string;
  /**
   * Who owns the rejection. `recorded_bldopt` means the recipe asked for a flag this image does not accept —
   * the recipe is inadmissible here and the submitted source is fine.
   */
  @IsOptional()
  @IsIn(["recorded_bldopt", "verifier_added"])
  rejected_build_option_origin?: "recorded_bldopt" | "verifier_added";
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  metadata_replay?: string[];
  @IsOptional() @IsNumber() metadata_replay_section_index?: number;
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  metadata_replay_dropped_keys?: string[];
  @IsOptional()
  @IsIn(["deployed_wasm_contractmetav0"])
  metadata_replay_source?: "deployed_wasm_contractmetav0";
  @IsOptional() @IsString() extraction_normalisation?: string;
  /**
   * How the rebuilt artifact was chosen. `output_mount_confirmed_by_report` means the sole artifact in the
   * output mount, named by the build tool's own report. `build_tool_report` is the earlier mechanism, where the
   * report alone chose the file; rows and reports already published carry it.
   */
  @IsOptional()
  @IsIn(["build_tool_report", "output_mount_confirmed_by_report"])
  artifact_selection?: "build_tool_report" | "output_mount_confirmed_by_report";
  /** The in-container path the build tool reported producing. */
  @IsOptional() @IsString() reported_artifact_path?: string;
  /** Whether the build tool's reported hash matched the bytes found on disk afterwards. */
  @IsOptional()
  @IsBoolean()
  reported_artifact_hash_verified?: boolean;
  @IsOptional() @IsBoolean() timed_out?: boolean;
  @SchemaHint({ nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber()
  exit_code?: number | null;
  @IsOptional() @IsString() stdout_excerpt?: string;
  @IsOptional() @IsString() stderr_excerpt?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => ReferenceAlignmentDto)
  reference_alignment?: ReferenceAlignmentDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => WasmComparisonDiagnostics)
  wasm_compare?: WasmComparisonDiagnostics;
  @IsOptional() @IsArray() @IsString({ each: true }) likely_causes?: string[];
}

const sourceReconstructionOutcomes = ["adopted", "hash_mismatch", "failed"] as const;

/**
 * Only the three outcomes that say something are published: `adopted` explains why the published
 * `source_sha256` is not the hash of the uploaded bytes, and the other two are what the submitter is owed when
 * the chain correspondence is lost.
 */
export class SourceReconstruction {
  @IsIn(sourceReconstructionOutcomes) outcome!: (typeof sourceReconstructionOutcomes)[number];
  @IsOptional() @IsString() detail?: string;
}

export class VerificationResultSummary {
  @IsIn(verificationStatuses) status_summary!: VerificationStatus;
  @IsString() wasm_hash!: string;
  @IsOptional() @IsString() expected_wasm_hash?: string;
  @IsOptional() @IsString() rebuilt_wasm_hash?: string;
  @IsOptional() @IsBoolean() matched?: boolean;
  /**
   * The byte-level verdict (`rebuilt_wasm_hash` vs the hash actually compared against) still publishes and is
   * permanently true, but the *contract → hash* binding recorded at submission no longer holds, so the
   * by-contract index is deliberately not updated for this job: asserting a binding we know is stale would be
   * worse than asserting nothing.
   */
  @IsOptional()
  @IsBoolean()
  contract_binding_drifted?: boolean;
  @IsOptional()
  @IsIn(["metadata_backed", "retroactive_manual"])
  verification_path?: "metadata_backed" | "retroactive_manual";
  /**
   * `source_archive_not_chain_recorded`. Its presence *is* the statement that the CLI path was tried; absence
   * means it was never routed, which `provenance.recipe_source` already says.
   */
  @IsOptional() @IsString() verify_attempt_reason?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => SourceReconstruction)
  source_reconstruction?: SourceReconstruction;
  @IsOptional()
  @IsIn(["wasm_metadata", "user_submitted_manifest"])
  evidence_source?: "wasm_metadata" | "user_submitted_manifest";
  @IsOptional()
  @ValidateNested()
  @Type(() => SandboxDiagnostics)
  sandbox_diagnostics?: SandboxDiagnostics;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() detail?: string;
  @IsOptional() @IsString() artifact_url?: string;
  @IsOptional() @IsString() artifact_sha256?: string;
  @IsOptional() @IsString() arweave_tx_id?: string;
  @IsOptional() @IsString() verified_at?: string;
}

// One verifier's pointer to its own published result. The by-hash/by-contract indexes this
// described were deleted (ADR-010), and its producer (toResultPointer) with them — no code
// constructs or reads this class today. Kept as a type, not deleted, pending an owner's call.
export class ResultPointer {
  @IsString() status!: string;
  @IsOptional() @IsString() wasm_hash?: string;
  @IsOptional() @IsString() contract_id?: string;
  @IsString() verifier_id!: string;
  @IsString() verified_at!: string;
  @IsString() artifact_url!: string;
  @IsString() artifact_sha256!: string;
  @IsOptional() @IsString() arweave_tx_id?: string;
}
