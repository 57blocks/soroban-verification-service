import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScvsLogger, resolveContainerManifestPath, stderrOnlySink } from "@scvs/core";
import { runCommand, sha256File } from "@scvs/core/process";
import { CONTAINER_ARTIFACT_DIR, CONTAINER_OUT_DIR, parseBuildArtifactReports, selectArtifactFromOutput, snapshotWasmPaths } from "./artifact-selection.js";
import { CONTAINER_CLI_ENTRYPOINT, assembleBuildCommand, rejectedBuildArgument, resolveAddedEnvironment } from "./argument-policy.js";
import { dockerEnvOptions, leadingBuildArgs, replayableBuildOptions, resolveManifestPath } from "./build-options.js";
import { cliFailure, dockerBuildDiagnostics, dockerPrefetchDiagnostics, dockerPrefetchPolicyDiagnostics, dockerUnavailableDiagnostics } from "./diagnostics.js";
import { evaluatePrefetchEgressPolicy, evaluateVendoredEgressPolicy } from "./egress-policy.js";
import { referenceAlignment } from "./reference-alignment.js";
import { cliTimeoutMs, dockerFinalSandboxOptions, dockerResourceLimits } from "./run-cli.config.js";
import type { BuildOutcomeClassification, RunCliInput, RunCliOutcome, RunCliResult } from "./run-cli.types.js";
import { authenticateForImage, checkDockerAvailable, prefetchCargoDependencies, requireExtractedSourceRoot, stageSourceForOfflineBuild, summarizeDockerCommand } from "./sandbox-runtime.js";
import { detectSourceCargoSourceOverride, resolveTrustedToolchain, writeVendorCargoConfig } from "./toolchain.js";

const logger = new ScvsLogger("run-cli", { sink: stderrOnlySink });

export function classifyRunCliOutcome(outcome: RunCliOutcome): BuildOutcomeClassification {
  if (outcome === "comparison_mismatch") return "comparison_mismatch";
  if (outcome === "cli_failure") return "cli_failure";
  return "success";
}

export async function runCli(input: RunCliInput): Promise<RunCliResult> {
  return runManualRebuild(input);
}

async function runManualRebuild(input: RunCliInput): Promise<RunCliResult> {
  const sourcePath = input.source.workspace_path;
  if (!sourcePath) {
    return cliFailure("source_not_local_for_fallback", "docker_build_image_rebuild", null, {
      runner: "docker_build_image_rebuild",
      detail: "Manual-evidence rebuild requires a materialized source path from the handoff.",
      reference_alignment: referenceAlignment(),
    });
  }

  const preparedSource = await requireExtractedSourceRoot(sourcePath);
  if (!preparedSource.ok) {
    return cliFailure(preparedSource.reason, "docker_build_image_rebuild", null, {
      runner: "docker_build_image_rebuild",
      source_path: sourcePath,
      detail: preparedSource.detail,
    });
  }
  const sourceRoot = preparedSource.source_root;

  const containerManifest = resolveContainerManifestPath(input.build.workspace_path);
  if (!containerManifest.ok) {
    return cliFailure(containerManifest.reason, "docker_build_image_rebuild", null, {
      runner: "docker_build_image_rebuild",
      source_root: sourceRoot,
      manifest_path: input.build.workspace_path,
      detail: containerManifest.detail,
    });
  }
  const manifestPath = resolveManifestPath(sourceRoot, input.build.workspace_path);
  if (!existsSync(manifestPath)) {
    return cliFailure("manifest_path_not_found", "docker_build_image_rebuild", null, {
      runner: "docker_build_image_rebuild",
      source_root: sourceRoot,
      manifest_path: manifestPath,
    });
  }

  const resourceLimits = dockerResourceLimits(input.config);
  const finalSandbox = dockerFinalSandboxOptions(input.config);
  const docker = await checkDockerAvailable(input.config);
  if (!docker.ok) {
    return cliFailure(
      "sandbox_unavailable",
      "docker_build_image_rebuild",
      null,
      {
        runner: "docker_build_image_rebuild",
        detail: "Docker is not available, so the builder cannot start the rebuild sandbox.",
        build_image: input.build.image,
        source_root: sourceRoot,
        manifest_path: manifestPath,
        container_manifest_path: containerManifest.path,
        docker_check: docker.result,
      },
      dockerUnavailableDiagnostics(input, docker.result, containerManifest.path),
    );
  }

  const registryAuth = await authenticateForImage(input.build.image, input.config);
  if (!registryAuth.ok) {
    return cliFailure(registryAuth.reason, "docker_build_image_rebuild", null, {
      runner: "docker_build_image_rebuild",
      build_image: input.build.image,
      source_root: sourceRoot,
      detail: registryAuth.detail,
    });
  }

  const stagedSource = await stageSourceForOfflineBuild(sourceRoot, input.config);
  if (!stagedSource.ok) {
    return cliFailure(stagedSource.reason, "docker_build_image_rebuild", null, {
      runner: "docker_build_image_rebuild",
      source_root: sourceRoot,
      detail: stagedSource.detail,
      ...(stagedSource.copy ? { copy: stagedSource.copy } : {}),
    });
  }
  const offlineSourceRoot = stagedSource.source_root;
  const offlineManifestPath = resolveManifestPath(offlineSourceRoot, input.build.workspace_path);

  const outDir = await mkdtemp(join(tmpdir(), "scvs-build-"));
  // Separate from `outDir` so the only `.wasm` here is one the build tool put there.
  const artifactDir = await mkdtemp(join(tmpdir(), "scvs-artifact-"));
  await mkdir(join(outDir, "tmp"), { recursive: true });
  const vendorDir = join(outDir, "vendor");
  const cargoHomeDir = join(outDir, "cargo-home");

  const toolchain = await resolveTrustedToolchain(input.build.image, offlineSourceRoot, input.config);
  if (!toolchain.ok) {
    return cliFailure(
      toolchain.reason,
      "docker_build_image_rebuild",
      toolchain.probe.exit_code,
      {
        runner: "docker_build_image_rebuild",
        build_image: input.build.image,
        source_root: offlineSourceRoot,
        ...(toolchain.sourceToolchainFile
          ? { source_rust_toolchain_file: toolchain.sourceToolchainFile }
          : {}),
        toolchain_probe: toolchain.probe,
        detail: toolchain.detail,
      },
    );
  }
  const sourceToolchainFile = toolchain.sourceToolchainFile;

  const egressPolicy = await evaluatePrefetchEgressPolicy(offlineSourceRoot, input.config);
  if (!egressPolicy.ok) {
    return cliFailure(
      "dependency_prefetch_policy_rejected",
      "docker_build_image_rebuild",
      null,
      {
        runner: "docker_build_image_rebuild",
        build_image: input.build.image,
        source_root: offlineSourceRoot,
        manifest_path: offlineManifestPath,
        container_manifest_path: containerManifest.path,
        out_dir: outDir,
        blocked_url: egressPolicy.blocked_url,
        detail: egressPolicy.detail,
      },
      dockerPrefetchPolicyDiagnostics({
        input,
        sourceRoot: offlineSourceRoot,
        outDir,
        manifestPath: offlineManifestPath,
        containerManifestPath: containerManifest.path,
        resourceLimits,
        policy: egressPolicy,
      }),
    );
  }
  const prefetch = await prefetchCargoDependencies({
    input,
    sourceRoot: offlineSourceRoot,
    outDir,
    cargoHomeDir,
    containerManifestPath: containerManifest.path,
    resourceLimits,
    finalSandbox,
    vendorDir,
    egressPolicy,
    // Unconditional: this stage takes only trusted config, and a recorded `bldopt --env` is submitted input.
    rustupToolchain: toolchain.toolchain,
  });
  if (!prefetch.ok) {
    return cliFailure(
      "dependency_prefetch_failed",
      "docker_build_image_rebuild",
      prefetch.result.exit_code,
      {
        runner: "docker_build_image_rebuild",
        build_image: input.build.image,
        source_root: offlineSourceRoot,
        manifest_path: offlineManifestPath,
        container_manifest_path: containerManifest.path,
        out_dir: outDir,
        cargo_home: cargoHomeDir,
        vendor_dir: "/vendor",
        prefetch: prefetch.result,
      },
      dockerPrefetchDiagnostics({
        input,
        prefetch: prefetch.result,
        prefetchCommand: prefetch.command,
        prefetchCommandSummary: prefetch.commandSummary,
        sourceRoot: offlineSourceRoot,
        outDir,
        manifestPath: offlineManifestPath,
        containerManifestPath: containerManifest.path,
        cargoHomeDir,
        vendorDir,
        resourceLimits,
        finalSandbox,
        rustupToolchain: toolchain.toolchain,
        egressPolicy,
      }),
    );
  }
  const vendoredEgressPolicy = await evaluateVendoredEgressPolicy(vendorDir, egressPolicy.allowed_hosts);
  if (!vendoredEgressPolicy.ok) {
    return cliFailure(
      "dependency_prefetch_policy_rejected",
      "docker_build_image_rebuild",
      null,
      {
        runner: "docker_build_image_rebuild",
        build_image: input.build.image,
        source_root: offlineSourceRoot,
        manifest_path: offlineManifestPath,
        container_manifest_path: containerManifest.path,
        out_dir: outDir,
        blocked_url: vendoredEgressPolicy.blocked_url,
        detail: `Transitive dependency introduced a disallowed host: ${vendoredEgressPolicy.detail}`,
      },
      dockerPrefetchPolicyDiagnostics({
        input,
        sourceRoot: offlineSourceRoot,
        outDir,
        manifestPath: offlineManifestPath,
        containerManifestPath: containerManifest.path,
        resourceLimits,
        policy: vendoredEgressPolicy,
      }),
    );
  }

  const sourceCargoOverride = await detectSourceCargoSourceOverride(offlineSourceRoot);
  if (sourceCargoOverride) {
    return cliFailure(
      "source_cargo_source_override_conflict",
      "docker_build_image_rebuild",
      null,
      {
        runner: "docker_build_image_rebuild",
        build_image: input.build.image,
        source_root: offlineSourceRoot,
        source_cargo_config: sourceCargoOverride,
        detail:
          `The submitted source defines its own [source.*] cargo configuration in ${sourceCargoOverride}, ` +
          "which takes precedence over the vendored-sources redirect and cannot be honoured in the " +
          "offline rebuild sandbox.",
      },
    );
  }
  const cargoConfigPath = await writeVendorCargoConfig(cargoHomeDir, "/vendor");

  const replayedOptions = replayableBuildOptions(input.build.bldopt);
  if (replayedOptions.unparsable.length) {
    return cliFailure(
      "bldopt_unparsable",
      "docker_build_image_rebuild",
      null,
      {
        runner: "docker_build_image_rebuild",
        build_image: input.build.image,
        source_root: offlineSourceRoot,
        manifest_path: offlineManifestPath,
        container_manifest_path: containerManifest.path,
        unparsable_bldopts: replayedOptions.unparsable,
        detail: "One or more recorded bldopt entries could not be parsed as a single shell word.",
      },
    );
  }
  const containerEnvResult = resolveAddedEnvironment({
    recordedEnv: dockerEnvOptions(input.build.bldopt),
    recordedBuildArgs: replayedOptions.forwarded,
    cargoHome: `${CONTAINER_OUT_DIR}/cargo-home`,
    cargoNetOffline: true,
    rustupToolchain: toolchain.toolchain,
  });
  if (!containerEnvResult.ok) {
    return cliFailure(
      containerEnvResult.reason,
      "docker_build_image_rebuild",
      null,
      {
        runner: "docker_build_image_rebuild",
        build_image: input.build.image,
        source_root: offlineSourceRoot,
        manifest_path: offlineManifestPath,
        container_manifest_path: containerManifest.path,
        detail: containerEnvResult.detail,
      },
    );
  }
  const containerEnv = containerEnvResult.env;

  const metadataArgs = (input.build.metadata_replay ?? []).flatMap((entry) => [
    "--meta",
    entry,
  ]);
  const forwardedOptions = metadataArgs.length
    ? removeRecordedMetaBldopts(replayedOptions.forwarded)
    : replayedOptions.forwarded;

  const buildCommand = assembleBuildCommand({
    dockerArgs: [
      "docker",
      "run",
      "--rm",
      ...resourceLimits.args,
      ...finalSandbox.args,
      "--network",
      "none",
      "-v",
      `${offlineSourceRoot}:/source:ro`,
      "-v",
      `${vendorDir}:/vendor:ro`,
      "-v",
      `${outDir}:${CONTAINER_OUT_DIR}`,
      "-v",
      `${artifactDir}:${CONTAINER_ARTIFACT_DIR}`,
      "-w",
      "/source",
    ],
    env: containerEnv,
    image: input.build.image,
    leading: leadingBuildArgs(input.build.bldarg),
    forwarded: [...forwardedOptions, ...metadataArgs],
    manifestPath: containerManifest.path,
    packageName: input.build.package,
  });
  const commandSummary = summarizeDockerCommand({
    command: buildCommand,
    image: input.build.image,
    containerManifestPath: containerManifest.path,
    hasEnv: containerEnv.length > 0,
    resourceLimits,
    finalSandbox,
    network: "none",
    entrypoint: CONTAINER_CLI_ENTRYPOINT,
    vendorMount: "/vendor:ro",
  });
  // Taken before the build, so it describes what the submission shipped rather than what the build produced.
  const preExistingWasm = new Set([
    ...(await snapshotWasmPaths(offlineSourceRoot)),
    ...(await snapshotWasmPaths(outDir)),
    ...(await snapshotWasmPaths(artifactDir)),
  ]);
  if (preExistingWasm.size) {
    logger.warn("source shipped pre-existing Wasm artifacts; they are excluded from selection (AR2)", {
      pre_existing_wasm_count: preExistingWasm.size,
    });
  }

  const build = await runCommand(buildCommand, { timeout_ms: cliTimeoutMs(input.config) });
  const rejectedArgument = rejectedBuildArgument({
    stderr: `${build.stdout}\n${build.stderr}`,
    argv: buildCommand,
    replayedBldopts: forwardedOptions,
  });
  const baseDiagnostics = dockerBuildDiagnostics({
    input,
    build,
    command: buildCommand,
    commandSummary,
    sourceRoot: offlineSourceRoot,
    outDir,
    manifestPath: offlineManifestPath,
    containerManifestPath: containerManifest.path,
    prefetch,
    cargoHomeDir,
    vendorDir,
    resourceLimits,
    finalSandbox,
    egressPolicy,
    network: "none",
    cargoConfigPath,
    rustupToolchain: toolchain.toolchain,
    sourceToolchainFile,
    extractionNormalisation: preparedSource.extraction_normalisation,
    replayedBldopts: forwardedOptions,
    unparsableBldopts: replayedOptions.unparsable.map((entry) => `${entry.entry}: ${entry.reason}`),
    ...(rejectedArgument ? { rejectedBuildArgument: rejectedArgument } : {}),
    metadataReplay: input.build.metadata_replay,
  });
  if (build.exit_code !== 0) {
    return cliFailure(
      rejectedArgument
        ? rejectedArgument.origin === "recorded_bldopt"
          ? "recorded_build_option_unsupported"
          : "added_build_option_unsupported"
        : "rebuild_command_failed",
      "docker_build_image_rebuild",
      build.exit_code,
      {
        runner: "docker_build_image_rebuild",
        build_image: input.build.image,
        source_root: offlineSourceRoot,
        manifest_path: offlineManifestPath,
        container_manifest_path: containerManifest.path,
        out_dir: outDir,
        cargo_home: cargoHomeDir,
        prefetch: prefetch.result,
        build,
      },
      baseDiagnostics,
    );
  }

  const buildOutput = `${build.stdout}\n${build.stderr}`;
  const reports = parseBuildArtifactReports(buildOutput);
  const outputArtifacts = [...(await snapshotWasmPaths(artifactDir))];
  const selection = selectArtifactFromOutput({ candidates: outputArtifacts, reports, artifactDir });
  const artifactFailureContext = {
    runner: "docker_build_image_rebuild",
    source_root: offlineSourceRoot,
    manifest_path: offlineManifestPath,
    container_manifest_path: containerManifest.path,
    out_dir: outDir,
    artifact_dir: artifactDir,
    cargo_home: cargoHomeDir,
    reported_artifacts: reports.map((r) => r.containerPath),
    output_artifacts: outputArtifacts,
    prefetch: prefetch.result,
    build,
  };
  if (!selection.ok) {
    return cliFailure(
      selection.reason,
      "docker_build_image_rebuild",
      build.exit_code,
      { ...artifactFailureContext, detail: selection.detail },
      baseDiagnostics,
    );
  }
  const rebuiltPath = selection.hostPath;

  if (preExistingWasm.has(rebuiltPath)) {
    return cliFailure(
      "reported_artifact_was_pre_existing",
      "docker_build_image_rebuild",
      build.exit_code,
      {
        ...artifactFailureContext,
        detail:
          `A file already existed at ${rebuiltPath} before the build started. A conformant source ` +
          "archive ships no build output, so this artifact was not produced by this rebuild.",
      },
      baseDiagnostics,
    );
  }

  const rebuiltInfo = await stat(rebuiltPath).catch(() => undefined);
  if (!rebuiltInfo?.isFile()) {
    return cliFailure(
      "reported_artifact_missing",
      "docker_build_image_rebuild",
      build.exit_code,
      {
        ...artifactFailureContext,
        detail: `The artifact at ${rebuiltPath} disappeared between selection and hashing.`,
      },
      baseDiagnostics,
    );
  }

  const rebuiltHash = await sha256File(rebuiltPath);

  const reportedHash = selection.sha256;
  if (reportedHash !== rebuiltHash) {
    return cliFailure(
      "reported_artifact_hash_mismatch",
      "docker_build_image_rebuild",
      build.exit_code,
      {
        ...artifactFailureContext,
        detail:
          `The build tool reported sha256=${reportedHash} for ${selection.containerPath}, ` +
          `but the file on disk hashes to ${rebuiltHash}. The artifact was modified after the ` +
          "build produced it.",
      },
      baseDiagnostics,
    );
  }

  const artifactDiagnostics = {
    artifact_selection: "output_mount_confirmed_by_report" as const,
    reported_artifact_path: selection.containerPath,
    reported_artifact_hash_verified: true,
    pre_existing_wasm_count: preExistingWasm.size,
  };

  return {
    outcome: "built",
    runner: "docker_build_image_rebuild",
    exit_code: build.exit_code,
    rebuilt_wasm_path: rebuiltPath,
    rebuilt_wasm_hash: rebuiltHash,
    rebuilt_wasm_size_bytes: rebuiltInfo.size,
    ...(input.source.source_sha256 ? { source_sha256: input.source.source_sha256 } : {}),
    ...(input.source.canonicalisation
      ? { source_canonicalisation: input.source.canonicalisation }
      : {}),
    diagnostics: {
      runner: "docker_build_image_rebuild",
      note:
        "Rebuilt inside the submitted digest-pinned build image because `stellar contract verify` was skipped for this job (mode=\"build\"). Comparison against the deployed Wasm hash happens in services/orchestrator-svc/src/publish, not here.",
      build_image: input.build.image,
      source_root: offlineSourceRoot,
      manifest_path: offlineManifestPath,
      container_manifest_path: containerManifest.path,
      out_dir: outDir,
      artifact_dir: artifactDir,
      cargo_home: cargoHomeDir,
      dependency_prefetch: {
        mode: "cargo_vendor",
        vendor_dir: vendorDir,
        result: prefetch.result,
      },
      rebuilt_wasm_path: rebuiltPath,
      ...artifactDiagnostics,
      build,
      reference_alignment: referenceAlignment(),
    },
    sandbox_diagnostics: {
      ...baseDiagnostics,
      ...artifactDiagnostics,
      rebuilt_wasm_hash: rebuiltHash,
      rebuilt_wasm_size_bytes: rebuiltInfo.size,
    },
  };
}

export function removeRecordedMetaBldopts(forwarded: string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < forwarded.length; index += 1) {
    const token = forwarded[index];
    if (token === "--meta") {
      if (forwarded[index + 1] !== undefined) {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--meta=")) {
      continue;
    }
    filtered.push(token);
  }
  return filtered;
}

export { parseBuildArtifactReports, resolveReportedArtifact, selectArtifactFromOutput } from "./artifact-selection.js";
export type { BuildArtifactReport } from "./artifact-selection.js";
export { extractBuildPackage, replayableBuildOptions, withDefaultBuildEnv } from "./build-options.js";
export type { ReplayedBuildOptions } from "./build-options.js";
export type { BuildOutcomeClassification, RunCliInput, RunCliMode, RunCliOutcome, RunCliResult, RunCliRuntimeConfig } from "./run-cli.types.js";
export { detectRustToolchainFile, detectSourceCargoSourceOverride, writeVendorCargoConfig } from "./toolchain.js";
