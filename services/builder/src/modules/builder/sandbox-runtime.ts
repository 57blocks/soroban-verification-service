// Container invocation: availability, source staging, dependency prefetch.

import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process-utils.js";
import type { CommandResult } from "./process-utils.js";
import { cliTimeoutMs, dependencyPrefetchTimeoutMs, dockerCheckTimeoutMs } from "./run-cli.config.js";
import type { DockerFinalSandboxOptions, DockerResourceLimits, PrefetchEgressPolicyOk, RunCliInput, RunCliRuntimeConfig } from "./run-cli.types.js";

export async function checkDockerAvailable(config?: RunCliRuntimeConfig): Promise<
  | { ok: true; result: CommandResult }
  | { ok: false; result: CommandResult }
> {
  const result = await runCommand(["docker", "ps"], {
    timeout_ms: dockerCheckTimeoutMs(config),
    mirrorOutput: false,
    // None of it belongs in a published build log.
    record: false,
  });
  return result.exit_code === 0 ? { ok: true, result } : { ok: false, result };
}

/** `<account>.dkr.ecr.<region>.amazonaws.com` → `<region>`. Exported for tests; it is the pure part. */
export function ecrRegistryRegion(registry: string): string | undefined {
  return /^[0-9]{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/.exec(registry)?.[1];
}

/** Authenticates the local docker client to ECR when — and only when — the build image lives there. */
export async function authenticateForImage(
  image: string,
  config?: RunCliRuntimeConfig,
  /** Injected for tests; production omits it and gets `runCommand`. Same seam as the composer's `fetchImpl`. */
  runner: typeof runCommand = runCommand,
): Promise<{ ok: true; skipped: boolean } | { ok: false; reason: string; detail: string }> {
  const registry = image.split("/")[0] ?? "";
  const region = ecrRegistryRegion(registry);
  if (!region) return { ok: true, skipped: true };

  const password = await runner(["aws", "ecr", "get-login-password", "--region", region], {
    timeout_ms: dockerCheckTimeoutMs(config),
    // Everything else in this file mirrors to CloudWatch on purpose — its output is build logs — which is
    // exactly why the one command whose stdout *is* a registry credential has to opt out.
    mirrorOutput: false,
    // `mirrorOutput` only governs this process's own stdout; the sink in `process-utils.ts` is what becomes the
    // public log.
    record: false,
  });
  if (password.exit_code !== 0 || !password.stdout.trim()) {
    return {
      ok: false,
      reason: "ecr_auth_failed",
      // `stderr` only, never `stdout`: on success stdout is the token.
      detail:
        `Could not obtain an ECR authorization token for ${registry} ` +
        `(exit ${password.exit_code ?? "none"}): ${password.stderr.slice(0, 300) || password.error || "no output"}`,
    };
  }

  const login = await runner(["docker", "login", "--username", "AWS", "--password-stdin", registry], {
    timeout_ms: dockerCheckTimeoutMs(config),
    stdin: password.stdout.trim(),
    mirrorOutput: false,
  });
  if (login.exit_code !== 0) {
    return {
      ok: false,
      reason: "ecr_auth_failed",
      detail:
        `\`docker login\` against ${registry} failed: ` +
        `${login.stderr.slice(0, 300) || login.error || "no output"}`,
    };
  }
  return { ok: true, skipped: false };
}

export function summarizeDockerCommand(input: {
  command: string[];
  image: string;
  containerManifestPath: string;
  hasEnv: boolean;
  resourceLimits: DockerResourceLimits;
  finalSandbox?: DockerFinalSandboxOptions;
  network?: "none";
  /** Printed because the build stage now names it rather than inheriting the image's. */
  entrypoint?: string;
  sourceMount?: "/source" | "/source:ro";
  vendorMount?: "/vendor" | "/vendor:ro";
}): string {
  const imageIndex = input.command.indexOf(input.image);
  const args = imageIndex >= 0 ? input.command.slice(imageIndex + 1) : [];
  const prefix = [
    "docker",
    "run",
    "--rm",
    ...input.resourceLimits.summaryArgs,
    ...(input.finalSandbox ? input.finalSandbox.summaryArgs : []),
    ...(input.network ? ["--network", input.network] : []),
    "-v",
    `<source>:${input.sourceMount || "/source:ro"}`,
    ...(input.vendorMount ? ["-v", `<vendor>:${input.vendorMount}`] : []),
    "-v",
    "<out>:/out",
    "-w",
    "/source",
    ...(input.hasEnv ? ["-e", "<env>"] : []),
    ...(input.entrypoint ? ["--entrypoint", input.entrypoint] : []),
    input.image,
  ];
  return [...prefix, ...args].join(" ");
}

export async function stageSourceForOfflineBuild(sourceRoot: string, config?: RunCliRuntimeConfig): Promise<
  | { ok: true; source_root: string }
  | { ok: false; reason: string; detail: string; copy?: CommandResult }
> {
  const stagedParent = await mkdtemp(join(tmpdir(), "scvs-offline-src-"));
  const stagedRoot = join(stagedParent, "source");
  await mkdir(stagedRoot, { recursive: true });
  const copy = await runCommand(["cp", "-R", `${sourceRoot}/.`, stagedRoot], {
    timeout_ms: cliTimeoutMs(config),
  });
  if (copy.exit_code !== 0) {
    return {
      ok: false,
      reason: "source_stage_copy_failed",
      detail: "Could not copy materialized source before offline rebuild staging.",
      copy,
    };
  }
  return { ok: true, source_root: stagedRoot };
}

/** Stage one: fetch the dependency set, then hand it to a build stage that has no network at all. */
export async function prefetchCargoDependencies(input: {
  input: RunCliInput;
  sourceRoot: string;
  outDir: string;
  cargoHomeDir: string;
  containerManifestPath: string;
  resourceLimits: DockerResourceLimits;
  finalSandbox: DockerFinalSandboxOptions;
  vendorDir: string;
  egressPolicy: PrefetchEgressPolicyOk;
  rustupToolchain?: string;
}): Promise<
  | { ok: true; result: CommandResult; command: string[]; commandSummary: string }
  | { ok: false; result: CommandResult; command: string[]; commandSummary: string }
> {
  await mkdir(join(input.outDir, "cargo-home"), { recursive: true });
  await mkdir(input.vendorDir, { recursive: true });
  const command = [
    "docker",
    "run",
    "--rm",
    ...input.resourceLimits.args,
    ...input.finalSandbox.args,
    "--entrypoint",
    "cargo",
    "-v",
    `${input.sourceRoot}:/source:ro`,
    "-v",
    `${input.vendorDir}:/vendor`,
    "-v",
    `${input.outDir}:/out`,
    "-w",
    "/source",
    "-e",
    "CARGO_HOME=/out/cargo-home",
    ...(input.rustupToolchain ? ["-e", `RUSTUP_TOOLCHAIN=${input.rustupToolchain}`] : []),
    input.input.build.image,
    "vendor",
    "--locked",
    "--manifest-path",
    input.containerManifestPath,
    "/vendor",
  ];
  const commandSummary = summarizeDockerCommand({
    command,
    image: input.input.build.image,
    containerManifestPath: input.containerManifestPath,
    hasEnv: true,
    resourceLimits: input.resourceLimits,
    finalSandbox: input.finalSandbox,
    entrypoint: "cargo",
    sourceMount: "/source:ro",
    vendorMount: "/vendor",
  });
  const result = await runCommand(command, { timeout_ms: dependencyPrefetchTimeoutMs(input.input.config) });
  return result.exit_code === 0
    ? { ok: true, result, command, commandSummary }
    : { ok: false, result, command, commandSummary };
}

export async function requireExtractedSourceRoot(sourcePath: string): Promise<
  | { ok: true; source_root: string; extraction_normalisation?: string }
  | { ok: false; reason: string; detail: string }
> {
  const info = await stat(sourcePath).catch(() => undefined);
  if (!info) {
    return {
      ok: false,
      reason: "source_path_not_found",
      detail: "The materialized source path no longer exists.",
    };
  }
  if (info.isDirectory()) return { ok: true, source_root: sourcePath };

  // Extraction now happens in the materialiser container, which holds no socket
  // (modules/materialise/materialise.service.ts).
  return {
    ok: false,
    reason: "source_not_extracted",
    detail:
      "The handoff pointed at an archive, not an extracted directory. Extraction belongs to the " +
      "materialiser container (CE1); this process must never unpack submitted bytes.",
  };
}
