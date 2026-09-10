import type { ConfigService } from "@nestjs/config";
function optionalNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * `@nestjs/config`'s single loader for this service (see query-svc/src/config/configuration.ts for the pattern
 * this mirrors).
 */
const configuration = () => ({
  // The path BOTH builder containers see, and which must be REAL ON THE HOST at the same path.
  handoffRoot: process.env.SCVS_HANDOFF_ROOT,
  jobParamsJson: process.env.SCVS_JOB_PARAMS_JSON,
  // `jobParamsInput` decides which one a container actually reads; both stay optional so either orchestrator
  // generation can drive this image during the rollout.
  jobParamsUrl: process.env.SCVS_JOB_PARAMS_URL,
  artifactDir: process.env.SCVS_ARTIFACT_DIR,
  sourceFetchTimeoutMs: optionalNumberEnv("SCVS_SOURCE_FETCH_TIMEOUT_MS"),
  maxSourceArchiveBytes: optionalNumberEnv("SCVS_MAX_SOURCE_ARCHIVE_BYTES"),
  tarTimeoutMs: optionalNumberEnv("SCVS_TAR_TIMEOUT_MS"),
  maxSourceArchiveEntries: optionalNumberEnv("SCVS_MAX_SOURCE_ARCHIVE_ENTRIES"),
  maxSourceArchiveUncompressedBytes: optionalNumberEnv("SCVS_MAX_SOURCE_ARCHIVE_UNCOMPRESSED_BYTES"),
  // `stellarDataHome` was read here — `STELLAR_DATA_HOME || XDG_DATA_HOME` — so the value the CLI subprocess
  // would use appeared in the verify path's diagnostics.
  cliTimeoutMs: optionalNumberEnv("SCVS_CLI_TIMEOUT_MS"),
  dependencyPrefetchTimeoutMs: optionalNumberEnv("SCVS_DEPENDENCY_PREFETCH_TIMEOUT_MS"),
  dockerCheckTimeoutMs: optionalNumberEnv("SCVS_DOCKER_CHECK_TIMEOUT_MS"),
  dockerHost: process.env.SCVS_DOCKER_HOST,
  prefetchAllowedHosts: process.env.SCVS_PREFETCH_ALLOWED_HOSTS
    ? process.env.SCVS_PREFETCH_ALLOWED_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean)
    : undefined,
  dockerCpus: process.env.SCVS_DOCKER_CPUS,
  dockerMemory: process.env.SCVS_DOCKER_MEMORY,
  dockerPidsLimit: process.env.SCVS_DOCKER_PIDS_LIMIT,
  dockerUser: process.env.SCVS_DOCKER_USER,
});

export default configuration;

/** The exact shape this service's loader produces. */
export type AppConfig = ReturnType<typeof configuration>;

/** Inject this instead of the bare `ConfigService`. The DI token is still `ConfigService`. */
export type AppConfigService = ConfigService<AppConfig, true>;
