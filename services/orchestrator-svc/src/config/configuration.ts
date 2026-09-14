import type { ConfigService } from "@nestjs/config";
import {
  buildArchitectures,
  DEFAULT_MAX_JOB_RETRY_ATTEMPTS,
  HTTP_TIMEOUT_DEFAULTS,
  type BuildArchitecture,
} from "@scvs/core";
import { readDbEnv } from "@scvs/db";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getArweaveConfig,
  getResultStorageConfig,
  getStagingStorageConfig,
  getVerifierIdentity,
  getVerifierPolicyConfig,
} from "@scvs/config";

/**
 * A type, not a string union inline at the read site, so `batch-dispatch.service.ts` can branch on it without
 * re-spelling the vocabulary.
 */
export type JobParamsTransport = "env_json" | "presigned_url";

function parseJobParamsTransport(raw: string | undefined): JobParamsTransport {
  return raw === "presigned_url" ? "presigned_url" : "env_json";
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The two architectures a rebuild can be dispatched to, spelled the way OCI spells them. */
export { buildArchitectures, type BuildArchitecture };

/** Which queue a build image that can run on *either* architecture goes to. */
function parseBuildArch(raw: string | undefined): BuildArchitecture {
  return buildArchitectures.includes(raw as BuildArchitecture) ? (raw as BuildArchitecture) : "arm64";
}

function containerName(raw: string | undefined, fallback: string): string {
  return raw?.trim() || fallback;
}

// Exported for direct unit coverage (test/configuration.spec.ts).
export function clampConcurrency(raw: string | undefined): number {
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 8);
}

/** Unlike `clampConcurrency`, the fallback is `globalCap` itself, not a fixed floor of 1. */
export function clampTestnetConcurrency(raw: string | undefined, globalCap: number): number {
  if (!raw) return globalCap;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return globalCap;
  return Math.min(parsed, globalCap);
}

/**
 * `@nestjs/config`'s single loader for this service (see query-svc/src/config/configuration.ts for the pattern
 * this mirrors).
 */
const configuration = () => ({
  // O9's drain window: how long we keep serving after SIGTERM so readiness can go false and the balancer can
  // deregister us before we leave.
  drainGraceMs: numberEnv("SCVS_DRAIN_GRACE_MS", 15_000),
  port: numberEnv("PORT", 5002),
  // The three `http.Server` deadlines main.ts applies after listen(). Node's own defaults are not neutral —
  // its 5 s keepAliveTimeout sits below the balancer's idle timeout and answers 502 on a reused connection.
  httpTimeouts: {
    requestTimeoutMs: numberEnv("SCVS_HTTP_REQUEST_TIMEOUT_MS", HTTP_TIMEOUT_DEFAULTS.requestTimeoutMs),
    headersTimeoutMs: numberEnv("SCVS_HTTP_HEADERS_TIMEOUT_MS", HTTP_TIMEOUT_DEFAULTS.headersTimeoutMs),
    keepAliveTimeoutMs: numberEnv(
      "SCVS_HTTP_KEEP_ALIVE_TIMEOUT_MS",
      HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs,
    ),
    // What keepAliveTimeoutMs is checked against, so the 502 rule holds for a deployment fronted by something
    // other than this one's ALB. `0` says nothing fronts this server and skips the check.
    frontingProxyIdleTimeoutMs: numberEnv(
      "SCVS_HTTP_FRONTING_PROXY_IDLE_TIMEOUT_MS",
      HTTP_TIMEOUT_DEFAULTS.frontingProxyIdleTimeoutMs,
    ),
  },
  // The database connection app.module.ts feeds to DbModule.forRootAsync, so it travels ConfigService like
  // every other setting instead of @scvs/db reading POSTGRES_* off process.env itself. readDbEnv() deliberately
  // does not validate: this loader also runs where no database environment exists (generate-openapi.ts in CI).
  postgres: readDbEnv(),
  publishRecoveryIntervalMs: numberEnv(
    "SCVS_PUBLISH_RECOVERY_INTERVAL_MS",
    60_000
  ),
  // How many times publishing one job's verdict may fail before the recovery scan stops retrying it.
  maxPublishAttempts: numberEnv("SCVS_MAX_PUBLISH_ATTEMPTS", 10),
  // Three attempts at an hour's span is enough to ride out an RPC blip or a Batch capacity gap.
  maxJobRetryAttempts: numberEnv("SCVS_MAX_JOB_RETRY_ATTEMPTS", DEFAULT_MAX_JOB_RETRY_ATTEMPTS),
  workerPollIntervalMs: numberEnv("SCVS_WORKER_POLL_INTERVAL_MS", 2_000),
  // Stuck-rebuild reconciler (scheduler/rebuild-reconciler.scheduler.ts).
  rebuildReaperIntervalMs: numberEnv("SCVS_REBUILD_REAPER_INTERVAL_MS", 60_000),
  rebuildDispatchTimeoutMs: numberEnv("SCVS_REBUILD_DISPATCH_TIMEOUT_MS", 5 * 60_000),
  rebuildRunTimeoutMs: numberEnv("SCVS_REBUILD_RUN_TIMEOUT_MS", 3 * 60_000),
  // How long a source_archive_uploads row may sit "claimed" before a losing findOrCreate caller treats it as
  // abandoned.
  sourceArchiveClaimTimeoutMs: numberEnv("SCVS_SOURCE_ARCHIVE_CLAIM_TIMEOUT_MS", 5 * 60_000),
  // Same as sourceArchiveClaimTimeoutMs, for report_archive_uploads (see archive-and-recovery/decisions/
  // report-archive-dedup-needs-a-claim-row-too.md).
  reportArchiveClaimTimeoutMs: numberEnv("SCVS_REPORT_ARCHIVE_CLAIM_TIMEOUT_MS", 5 * 60_000),
  maxRebuiltWasmBytes: numberEnv("SCVS_MAX_REBUILT_WASM_BYTES", 16 * 1024 * 1024),
  workerConcurrency: clampConcurrency(process.env.SCVS_WORKER_CONCURRENCY),
  workerConcurrencyTestnet: clampTestnetConcurrency(
    process.env.SCVS_WORKER_CONCURRENCY_TESTNET,
    clampConcurrency(process.env.SCVS_WORKER_CONCURRENCY)
  ),
  jobStateChangeQueueUrl: process.env.SCVS_JOB_STATE_CHANGE_QUEUE_URL,
  awsRegion: process.env.AWS_REGION,
  // One queue per architecture: the compute environment behind each is single-architecture, and a build image
  // published for only one of them can only run on one of them.
  batchJobQueueArns: {
    arm64: process.env.SCVS_BATCH_JOB_QUEUE_ARN_ARM64,
    amd64: process.env.SCVS_BATCH_JOB_QUEUE_ARN_AMD64,
  } as Record<BuildArchitecture, string | undefined>,
  batchDefaultArch: parseBuildArch(process.env.SCVS_BATCH_DEFAULT_ARCH),
  // One family PER ARCHITECTURE, resolved from the same `arch` as the queue above — see
  // queue-selection.util.ts's header.
  batchJobDefinitionArns: {
    arm64: process.env.SCVS_BATCH_JOB_DEFINITION_ARN_ARM64,
    amd64: process.env.SCVS_BATCH_JOB_DEFINITION_ARN_AMD64,
  } as Record<BuildArchitecture, string | undefined>,
  // The two containers in the ecsProperties job definition, named separately because they now receive
  // *different* SCVS_JOB_PARAMS_JSON documents (see BatchDispatchService).
  batchMaterialiseContainerName: containerName(
    process.env.SCVS_BATCH_MATERIALISE_CONTAINER_NAME,
    "materialise"
  ),
  batchRunnerContainerName: containerName(process.env.SCVS_BATCH_RUNNER_CONTAINER_NAME, "runner"),
  // ── Bounded job-params transport ────────────────────────────────────────────────────
  // `env_json` (the default, and the behaviour of every deployment before this knob) injects each container's
  // full params document as SCVS_JOB_PARAMS_JSON.
  jobParamsTransport: parseJobParamsTransport(process.env.SCVS_JOB_PARAMS_TRANSPORT),
  // ── Composed build environments (ADR-017) ────────────────────────────────────────────────────
  // Optional here, like the builder's own ARNs, because a deployment that only ever serves cli-58 needs no
  // composer fleet.
  composerJobQueueArn: process.env.SCVS_COMPOSER_JOB_QUEUE_ARN,
  composerJobDefinitionArn: process.env.SCVS_COMPOSER_JOB_DEFINITION_ARN,
  // A bare repository URI, never a tag or digest — `composedEnvironmentImageReference()` appends the digest,
  // and validates that this side carries neither.
  composedEnvironmentRepositoryUri: process.env.SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI,
  // How long an `Environment` may sit in `composing` before `EnvironmentReconcilerScheduler` asks Batch about
  // it.
  environmentComposeTimeoutMs: numberEnv("SCVS_ENVIRONMENT_COMPOSE_TIMEOUT_MS", 10 * 60_000),
  environmentReconcilerIntervalMs: numberEnv(
    "SCVS_ENVIRONMENT_RECONCILER_INTERVAL_MS",
    60_000
  ),
  stellarCliPath: process.env.STELLAR_CLI_PATH || "stellar",
  artifactDir:
    process.env.SCVS_ARTIFACT_DIR || join(tmpdir(), "scvs-artifacts"),
  cliTimeoutMs: numberEnv("SCVS_CLI_TIMEOUT_MS", 120_000),
  // Optional: mainnet chain lookups only. Unset keeps the CLI's built-in mainnet entry, which is a docs
  // placeholder and fails any mainnet fetch — that is what a testnet-only deployment wants.
  mainnetRpcUrl: process.env.SCVS_MAINNET_RPC_URL,
  // Each service defines its own copy of this env var, matching this codebase's existing pattern.
  stagingSweepJobAgeCeilingMs: numberEnv("SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS", 14_400_000),
  // Counsel's range is 30-90 days for job metadata that never published; this takes the strict end, and
  // nothing operational wants longer (retention-and-pseudonymisation design.md RP-3).
  // Counsel's recommendation is 7 days, "30 only if operationally justified", and no operational case for
  // longer has been made. Provisional pending BL-SB10 (build-log-access design.md), which is SB10's owner's
  // to answer — this is the one value that decision moves.
  buildLogRetentionMs: numberEnv("SCVS_BUILD_LOG_RETENTION_MS", 7 * 24 * 60 * 60_000),
  buildLogSweepIntervalMs: numberEnv("SCVS_BUILD_LOG_SWEEP_INTERVAL_MS", 60 * 60_000),
  buildLogSweepBatchSize: numberEnv("SCVS_BUILD_LOG_SWEEP_BATCH_SIZE", 200),
  jobRetentionMs: numberEnv("SCVS_JOB_RETENTION_MS", 30 * 24 * 60 * 60_000),
  jobRetentionSweepIntervalMs: numberEnv("SCVS_JOB_RETENTION_SWEEP_INTERVAL_MS", 60 * 60_000),
  jobRetentionBatchSize: numberEnv("SCVS_JOB_RETENTION_BATCH_SIZE", 500),
  stagingStorage: getStagingStorageConfig(),
  resultStorage: getResultStorageConfig(),
  verifierIdentity: getVerifierIdentity(),
  verifierPolicy: getVerifierPolicyConfig(),
  arweave: getArweaveConfig(),
});

export default configuration;

/** The exact shape this service's loader produces. */
export type AppConfig = ReturnType<typeof configuration>;

/** Inject this instead of the bare `ConfigService`. The DI token is still `ConfigService`. */
export type AppConfigService = ConfigService<AppConfig, true>;
