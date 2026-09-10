// Diagnostics and failure-result builders.

import type { SandboxDiagnostics } from "@scvs/core";
import type { CommandResult } from "./process-utils.js";
import { excerpt, redactCommand, redactLocalPath, redactSecrets, redactUnknown, summarizeGenericCommand } from "./redact.js";
import { referenceAlignment } from "./reference-alignment.js";
import type { DockerFinalSandboxOptions, DockerResourceLimits, PrefetchEgressPolicyOk, PrefetchEgressPolicyRejected, RunCliInput, RunCliResult } from "./run-cli.types.js";

export function cliFailure(
  reason: string,
  runner: RunCliResult["runner"],
  exit_code: number | null,
  diagnostics: Record<string, unknown>,
  sandboxDiagnostics?: SandboxDiagnostics,
): RunCliResult {
  return {
    outcome: "cli_failure",
    runner,
    exit_code,
    reason,
    // Redacted here rather than at each call site: this bag is untyped and reaches the published artifact as
    // `failure_context`, so it is the one publishing path a field's type cannot cover.
    diagnostics: {
      reason,
      ...(redactUnknown(diagnostics) as Record<string, unknown>),
    },
    ...(sandboxDiagnostics ? { sandbox_diagnostics: sandboxDiagnostics } : {}),
  };
}

export function dockerUnavailableDiagnostics(
  input: RunCliInput,
  dockerCheck: CommandResult,
  containerManifestPath: string,
): SandboxDiagnostics {
  return {
    runner: "docker_build_image_rebuild",
    build_image: input.build.image,
    container_manifest_path: containerManifestPath,
    expected_wasm_hash: input.expected_wasm_hash,
    docker_available: false,
    docker_error: excerpt(dockerCheck.stderr || dockerCheck.error || dockerCheck.stdout),
    timed_out: dockerCheck.timed_out,
    exit_code: dockerCheck.exit_code,
    reference_alignment: referenceAlignment(),
  };
}

export function dockerPrefetchDiagnostics(input: {
  input: RunCliInput;
  prefetch: CommandResult;
  prefetchCommand: string[];
  prefetchCommandSummary: string;
  sourceRoot: string;
  outDir: string;
  manifestPath: string;
  containerManifestPath: string;
  cargoHomeDir: string;
  vendorDir: string;
  resourceLimits: DockerResourceLimits;
  finalSandbox: DockerFinalSandboxOptions;
  rustupToolchain?: string;
  egressPolicy: PrefetchEgressPolicyOk;
}): SandboxDiagnostics {
  return {
    runner: "docker_build_image_rebuild",
    build_image: input.input.build.image,
    command: redactCommand(input.prefetchCommand),
    command_summary: input.prefetchCommandSummary,
    source_mount: "/source:ro",
    output_mount: "/out",
    cargo_home: "/out/cargo-home",
    manifest_path: redactLocalPath(input.manifestPath),
    container_manifest_path: input.containerManifestPath,
    expected_wasm_hash: input.input.expected_wasm_hash,
    docker_available: true,
    docker_cpus: input.resourceLimits.cpus,
    docker_memory: input.resourceLimits.memory,
    docker_pids_limit: input.resourceLimits.pidsLimit,
    docker_cap_drop: input.resourceLimits.capDrop,
    docker_security_opt: input.resourceLimits.securityOpt,
    docker_read_only: input.finalSandbox.readOnly,
    docker_user: input.finalSandbox.user,
    docker_tmpfs: input.finalSandbox.tmpfs,
    ...(input.rustupToolchain ? { rustup_toolchain: input.rustupToolchain } : {}),
    toolchain_pinned: Boolean(input.rustupToolchain),
    dependency_prefetch: "cargo_vendor",
    dependency_prefetch_policy: "allowlist",
    dependency_prefetch_allowed_hosts: input.egressPolicy.allowed_hosts,
    dependency_vendor_dir: "/vendor",
    dependency_prefetch_exit_code: input.prefetch.exit_code,
    timed_out: input.prefetch.timed_out,
    exit_code: input.prefetch.exit_code,
    stdout_excerpt: excerpt(input.prefetch.stdout),
    stderr_excerpt: excerpt(input.prefetch.stderr || input.prefetch.error || ""),
    reference_alignment: referenceAlignment(),
  };
}

export function dockerPrefetchPolicyDiagnostics(input: {
  input: RunCliInput;
  sourceRoot: string;
  outDir: string;
  manifestPath: string;
  containerManifestPath: string;
  resourceLimits: DockerResourceLimits;
  policy: PrefetchEgressPolicyRejected;
}): SandboxDiagnostics {
  return {
    runner: "docker_build_image_rebuild",
    build_image: input.input.build.image,
    source_mount: "/source",
    output_mount: "/out",
    manifest_path: redactLocalPath(input.manifestPath),
    container_manifest_path: input.containerManifestPath,
    expected_wasm_hash: input.input.expected_wasm_hash,
    docker_available: true,
    docker_cpus: input.resourceLimits.cpus,
    docker_memory: input.resourceLimits.memory,
    docker_pids_limit: input.resourceLimits.pidsLimit,
    docker_cap_drop: input.resourceLimits.capDrop,
    docker_security_opt: input.resourceLimits.securityOpt,
    dependency_prefetch: "cargo_vendor",
    dependency_prefetch_policy: "allowlist",
    dependency_prefetch_allowed_hosts: input.policy.allowed_hosts,
    // Both carry a URL read out of the submitter's own Cargo files, so both go through redaction — userinfo and
    // query strings in a submitted registry URL are exactly what it is for.
    dependency_prefetch_blocked_url: redactSecrets(input.policy.blocked_url),
    stderr_excerpt: excerpt(input.policy.detail),
    reference_alignment: referenceAlignment(),
  };
}

export function dockerBuildDiagnostics(input: {
  input: RunCliInput;
  build: CommandResult;
  command: string[];
  commandSummary: string;
  sourceRoot: string;
  outDir: string;
  manifestPath: string;
  containerManifestPath: string;
  prefetch: { ok: true; result: CommandResult; command: string[]; commandSummary: string };
  cargoHomeDir: string;
  vendorDir: string;
  resourceLimits: DockerResourceLimits;
  finalSandbox: DockerFinalSandboxOptions;
  egressPolicy: PrefetchEgressPolicyOk;
  network: "none";
  cargoConfigPath: string;
  rustupToolchain?: string;
  sourceToolchainFile?: string;
  extractionNormalisation?: string;
  replayedBldopts: string[];
  unparsableBldopts: string[];
  /** Set only when the CLI positively named an argument it rejected — see `rejectedBuildArgument`. */
  rejectedBuildArgument?: { flag: string; origin: "recorded_bldopt" | "verifier_added" };
  metadataReplay?: string[];
}): SandboxDiagnostics {
  return {
    runner: "docker_build_image_rebuild",
    build_image: input.input.build.image,
    command: redactCommand(input.command),
    command_summary: input.commandSummary,
    source_mount: "/source:ro",
    output_mount: "/out",
    cargo_target_dir: "/out/target",
    tmp_dir: "/out/tmp",
    cargo_home: "/out/cargo-home",
    cargo_net_offline: true,
    cargo_config_path: input.cargoConfigPath,
    ...(input.rustupToolchain ? { rustup_toolchain: input.rustupToolchain } : {}),
    toolchain_pinned: Boolean(input.rustupToolchain),
    ...(input.sourceToolchainFile ? { source_rust_toolchain_file: input.sourceToolchainFile } : {}),
    ...(input.extractionNormalisation ? { extraction_normalisation: input.extractionNormalisation } : {}),
    ...(input.replayedBldopts.length ? { replayed_bldopts: input.replayedBldopts } : {}),
    ...(input.unparsableBldopts.length ? { unparsable_bldopts: input.unparsableBldopts } : {}),
    // Absent on every failure this could not positively identify, which is most of them — the caller stays on
    // the generic `rebuild_command_failed` path there rather than guessing.
    ...(input.rejectedBuildArgument
      ? {
          rejected_build_option: input.rejectedBuildArgument.flag,
          rejected_build_option_origin: input.rejectedBuildArgument.origin,
        }
      : {}),
    ...(input.metadataReplay?.length
      ? {
          metadata_replay: input.metadataReplay,
          metadata_replay_source: "deployed_wasm_contractmetav0" as const,
        }
      : {}),
    manifest_path: redactLocalPath(input.manifestPath),
    container_manifest_path: input.containerManifestPath,
    expected_wasm_hash: input.input.expected_wasm_hash,
    docker_available: true,
    docker_cpus: input.resourceLimits.cpus,
    docker_memory: input.resourceLimits.memory,
    docker_pids_limit: input.resourceLimits.pidsLimit,
    docker_cap_drop: input.resourceLimits.capDrop,
    docker_security_opt: input.resourceLimits.securityOpt,
    docker_network: input.network,
    docker_read_only: input.finalSandbox.readOnly,
    docker_user: input.finalSandbox.user,
    docker_tmpfs: input.finalSandbox.tmpfs,
    dependency_prefetch: "cargo_vendor",
    dependency_prefetch_policy: "allowlist",
    dependency_prefetch_allowed_hosts: input.egressPolicy.allowed_hosts,
    dependency_vendor_dir: "/vendor",
    dependency_prefetch_exit_code: input.prefetch.result.exit_code,
    timed_out: input.build.timed_out,
    exit_code: input.build.exit_code,
    stdout_excerpt: excerpt(input.build.stdout),
    stderr_excerpt: excerpt(input.build.stderr || input.build.error || ""),
    reference_alignment: referenceAlignment(),
  };
}
