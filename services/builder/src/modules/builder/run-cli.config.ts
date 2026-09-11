// Runtime configuration accessors: `RunCliRuntimeConfig` first, then `process.env`, then a hardcoded default —
// the chain this module has always used.

import type {
  DockerFinalSandboxOptions,
  DockerResourceLimits,
  RunCliRuntimeConfig,
} from "./run-cli.types.js";

export function envString(name: string, fallback: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function cliTimeoutMs(config?: RunCliRuntimeConfig): number {
  return (
    config?.cliTimeoutMs || Number(process.env.SCVS_CLI_TIMEOUT_MS || 600_000)
  );
}

export function dependencyPrefetchTimeoutMs(
  config?: RunCliRuntimeConfig
): number {
  return (
    config?.dependencyPrefetchTimeoutMs ||
    Number(
      process.env.SCVS_DEPENDENCY_PREFETCH_TIMEOUT_MS || cliTimeoutMs(config)
    )
  );
}

export function dockerCheckTimeoutMs(config?: RunCliRuntimeConfig): number {
  return (
    config?.dockerCheckTimeoutMs ||
    Number(process.env.SCVS_DOCKER_CHECK_TIMEOUT_MS || 10_000)
  );
}

export function dockerResourceLimits(
  config?: RunCliRuntimeConfig
): DockerResourceLimits {
  const cpus = config?.dockerCpus || envString("SCVS_DOCKER_CPUS", "2");
  const memory = config?.dockerMemory || envString("SCVS_DOCKER_MEMORY", "2g");
  const pidsLimit =
    config?.dockerPidsLimit || envString("SCVS_DOCKER_PIDS_LIMIT", "512");
  const securityOpt = "no-new-privileges";
  const capDrop = "ALL";
  return {
    args: [
      ...(cpus ? ["--cpus", cpus] : []),
      ...(memory ? ["--memory", memory] : []),
      ...(pidsLimit ? ["--pids-limit", pidsLimit] : []),
      "--cap-drop",
      capDrop,
      "--security-opt",
      securityOpt,
    ],
    summaryArgs: [
      ...(cpus ? ["--cpus", cpus] : []),
      ...(memory ? ["--memory", memory] : []),
      ...(pidsLimit ? ["--pids-limit", pidsLimit] : []),
      "--cap-drop",
      capDrop,
      "--security-opt",
      securityOpt,
    ],
    cpus,
    memory,
    pidsLimit,
    capDrop,
    securityOpt,
  };
}

/** Who the sandboxed containers run as. */
function sandboxUser(config?: RunCliRuntimeConfig): string {
  const configured = config?.dockerUser || process.env.SCVS_DOCKER_USER?.trim();
  if (configured) return configured;
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const gid =
    typeof process.getgid === "function" ? process.getgid() : undefined;
  if (uid !== undefined && gid !== undefined && uid !== 0)
    return `${uid}:${gid}`;
  return "65532:65532";
}

export function dockerFinalSandboxOptions(
  config?: RunCliRuntimeConfig
): DockerFinalSandboxOptions {
  const user = sandboxUser(config);
  const tmpfs = [
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "/var/tmp:rw,nosuid,nodev,noexec,size=64m",
  ];
  const args = [
    "--read-only",
    "--user",
    user,
    ...tmpfs.flatMap((mount) => ["--tmpfs", mount]),
  ];
  return {
    args,
    summaryArgs: args,
    readOnly: true,
    user,
    tmpfs,
  };
}

export function prefetchAllowedHosts(config?: RunCliRuntimeConfig): string[] {
  if (config?.prefetchAllowedHosts?.length) {
    return config.prefetchAllowedHosts;
  }
  const configured = process.env.SCVS_PREFETCH_ALLOWED_HOSTS;
  if (configured) {
    return configured
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
  }
  return [
    "crates.io",
    "static.crates.io",
    "index.crates.io",
    "github.com",
    "raw.githubusercontent.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "githubusercontent.com",
    "gitlab.com",
    "bitbucket.org",
    "codeberg.org",
  ];
}
