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
  getStagingStorageConfig,
  getVerifierIdentity,
  getVerifierPolicyConfig,
} from "@scvs/config";
import { resultStorageConfigFromEnv } from "@scvs/storage-layout";

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

export { buildArchitectures, type BuildArchitecture };

function parseBuildArch(raw: string | undefined): BuildArchitecture {
  return buildArchitectures.includes(raw as BuildArchitecture) ? (raw as BuildArchitecture) : "arm64";
}

function containerName(raw: string | undefined, fallback: string): string {
  return raw?.trim() || fallback;
}

export function clampConcurrency(raw: string | undefined): number {
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 8);
}

export function clampTestnetConcurrency(raw: string | undefined, globalCap: number): number {
  if (!raw) return globalCap;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return globalCap;
  return Math.min(parsed, globalCap);
}

const configuration = () => ({
  drainGraceMs: numberEnv("SCVS_DRAIN_GRACE_MS", 15_000),
  port: numberEnv("PORT", 5002),
  // Node's 5 s default keepAliveTimeout sits below the balancer's idle timeout and answers 502 on reuse.
  httpTimeouts: {
    requestTimeoutMs: numberEnv("SCVS_REQUEST_TIMEOUT_MS", HTTP_TIMEOUT_DEFAULTS.requestTimeoutMs),
    headersTimeoutMs: numberEnv("SCVS_HEADERS_TIMEOUT_MS", HTTP_TIMEOUT_DEFAULTS.headersTimeoutMs),
    keepAliveTimeoutMs: numberEnv(
      "SCVS_KEEPALIVE_TIMEOUT_MS",
      HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs,
    ),
    // 0 means nothing fronts this server and skips the keep-alive check.
    frontingProxyIdleTimeoutMs: numberEnv(
      "SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS",
      HTTP_TIMEOUT_DEFAULTS.frontingProxyIdleTimeoutMs,
    ),
  },
  // readDbEnv() does not validate: this loader also runs where no database environment exists.
  postgres: readDbEnv(),
  publishRecoveryIntervalMs: numberEnv(
    "SCVS_PUBLISH_RECOVERY_INTERVAL_MS",
    60_000
  ),
  archiveRecoveryIntervalMs: numberEnv("SCVS_ARCHIVE_RECOVERY_INTERVAL_MS", 60_000),
  jobRetryIntervalMs: numberEnv("SCVS_JOB_RETRY_INTERVAL_MS", 60_000),
  statusLinkRecoveryIntervalMs: numberEnv("SCVS_STATUS_LINK_RECOVERY_INTERVAL_MS", 60_000),
  maxPublishAttempts: numberEnv("SCVS_MAX_PUBLISH_ATTEMPTS", 10),
  maxJobRetryAttempts: numberEnv("SCVS_MAX_JOB_RETRY_ATTEMPTS", DEFAULT_MAX_JOB_RETRY_ATTEMPTS),
  workerPollIntervalMs: numberEnv("SCVS_WORKER_POLL_INTERVAL_MS", 2_000),
  rebuildReaperIntervalMs: numberEnv("SCVS_REBUILD_REAPER_INTERVAL_MS", 60_000),
  rebuildDispatchTimeoutMs: numberEnv("SCVS_REBUILD_DISPATCH_TIMEOUT_MS", 5 * 60_000),
  rebuildRunTimeoutMs: numberEnv("SCVS_REBUILD_RUN_TIMEOUT_MS", 3 * 60_000),
  sourceArchiveClaimTimeoutMs: numberEnv("SCVS_SOURCE_ARCHIVE_CLAIM_TIMEOUT_MS", 5 * 60_000),
  reportArchiveClaimTimeoutMs: numberEnv("SCVS_REPORT_ARCHIVE_CLAIM_TIMEOUT_MS", 5 * 60_000),
  maxRebuiltWasmBytes: numberEnv("SCVS_MAX_REBUILT_WASM_BYTES", 16 * 1024 * 1024),
  workerConcurrency: clampConcurrency(process.env.SCVS_WORKER_CONCURRENCY),
  workerConcurrencyTestnet: clampTestnetConcurrency(
    process.env.SCVS_WORKER_CONCURRENCY_TESTNET,
    clampConcurrency(process.env.SCVS_WORKER_CONCURRENCY)
  ),
  jobStateChangeQueueUrl: process.env.SCVS_JOB_STATE_CHANGE_QUEUE_URL,
  awsRegion: process.env.AWS_REGION,
  batchJobQueueArns: {
    arm64: process.env.SCVS_BATCH_JOB_QUEUE_ARN_ARM64,
    amd64: process.env.SCVS_BATCH_JOB_QUEUE_ARN_AMD64,
  } as Record<BuildArchitecture, string | undefined>,
  batchDefaultArch: parseBuildArch(process.env.SCVS_BATCH_DEFAULT_ARCH),
  batchJobDefinitionArns: {
    arm64: process.env.SCVS_BATCH_JOB_DEFINITION_ARN_ARM64,
    amd64: process.env.SCVS_BATCH_JOB_DEFINITION_ARN_AMD64,
  } as Record<BuildArchitecture, string | undefined>,
  batchMaterialiseContainerName: containerName(
    process.env.SCVS_BATCH_MATERIALISE_CONTAINER_NAME,
    "materialise"
  ),
  batchRunnerContainerName: containerName(process.env.SCVS_BATCH_RUNNER_CONTAINER_NAME, "runner"),
  jobParamsTransport: parseJobParamsTransport(process.env.SCVS_JOB_PARAMS_TRANSPORT),
  composerJobQueueArn: process.env.SCVS_COMPOSER_JOB_QUEUE_ARN,
  composerJobDefinitionArn: process.env.SCVS_COMPOSER_JOB_DEFINITION_ARN,
  composedEnvironmentRepositoryUri: process.env.SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI,
  environmentComposeTimeoutMs: numberEnv("SCVS_ENVIRONMENT_COMPOSE_TIMEOUT_MS", 10 * 60_000),
  environmentReconcilerIntervalMs: numberEnv(
    "SCVS_ENVIRONMENT_RECONCILER_INTERVAL_MS",
    60_000
  ),
  stellarCliPath: process.env.STELLAR_CLI_PATH || "stellar",
  artifactDir:
    process.env.SCVS_ARTIFACT_DIR || join(tmpdir(), "scvs-artifacts"),
  cliTimeoutMs: numberEnv("SCVS_CLI_TIMEOUT_MS", 120_000),
  // Unset keeps the CLI's placeholder mainnet entry, which fails any mainnet fetch.
  mainnetRpcUrl: process.env.SCVS_MAINNET_RPC_URL,
  stagingSweepJobAgeCeilingMs: numberEnv("SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS", 14_400_000),
  buildLogRetentionMs: numberEnv("SCVS_BUILD_LOG_RETENTION_MS", 7 * 24 * 60 * 60_000),
  buildLogSweepIntervalMs: numberEnv("SCVS_BUILD_LOG_SWEEP_INTERVAL_MS", 60 * 60_000),
  buildLogSweepBatchSize: numberEnv("SCVS_BUILD_LOG_SWEEP_BATCH_SIZE", 200),
  jobRetentionMs: numberEnv("SCVS_JOB_RETENTION_MS", 30 * 24 * 60 * 60_000),
  jobRetentionSweepIntervalMs: numberEnv("SCVS_JOB_RETENTION_SWEEP_INTERVAL_MS", 60 * 60_000),
  jobRetentionBatchSize: numberEnv("SCVS_JOB_RETENTION_BATCH_SIZE", 500),
  stagingStorage: getStagingStorageConfig(),
  resultStorage: resultStorageConfigFromEnv(),
  verifierIdentity: getVerifierIdentity(),
  verifierPolicy: getVerifierPolicyConfig(),
  arweave: getArweaveConfig(),
});

export default configuration;

export type AppConfig = ReturnType<typeof configuration>;

export type AppConfigService = ConfigService<AppConfig, true>;
