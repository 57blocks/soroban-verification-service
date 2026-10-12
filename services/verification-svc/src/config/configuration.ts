import type { ConfigService } from "@nestjs/config";
import { HTTP_TIMEOUT_DEFAULTS } from "@scvs/core";
import { readDbEnv } from "@scvs/db";
import { resultStorageConfigFromEnv } from "@scvs/storage-layout";
import { tmpdir } from "node:os";
import { join } from "node:path";

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readThrottleLimit(): number {
  return numberEnv("SCVS_READ_THROTTLE_LIMIT", 600);
}

const configuration = () => ({
  drainGraceMs: numberEnv("SCVS_DRAIN_GRACE_MS", 15_000),
  port: numberEnv("PORT", 5000),
  // Node's 5 s keepAliveTimeout default sits below the balancer's idle timeout and answers 502 on a reused connection.
  httpTimeouts: {
    requestTimeoutMs: numberEnv("SCVS_REQUEST_TIMEOUT_MS", HTTP_TIMEOUT_DEFAULTS.requestTimeoutMs),
    headersTimeoutMs: numberEnv("SCVS_HEADERS_TIMEOUT_MS", HTTP_TIMEOUT_DEFAULTS.headersTimeoutMs),
    keepAliveTimeoutMs: numberEnv(
      "SCVS_KEEPALIVE_TIMEOUT_MS",
      HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs,
    ),
    // `0` means nothing fronts this server and skips the keepAliveTimeoutMs check.
    frontingProxyIdleTimeoutMs: numberEnv(
      "SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS",
      HTTP_TIMEOUT_DEFAULTS.frontingProxyIdleTimeoutMs,
    ),
  },
  // readDbEnv() must not validate: this loader also runs with no database environment (generate-openapi.ts).
  postgres: readDbEnv(),
  resultStorage: resultStorageConfigFromEnv(),
  serviceVersion: process.env.npm_package_version || "0.1.0",
  uploadRateLimitPerMinute: numberEnv("SCVS_UPLOAD_RATE_LIMIT_PER_MINUTE", 60),
  throttleLimit: numberEnv("SCVS_THROTTLE_LIMIT", 60),
  readThrottleLimit: readThrottleLimit(),
  uploadCleanupIntervalMs: numberEnv("SCVS_UPLOAD_CLEANUP_INTERVAL_MS", 60_000),
  abuseSweepIntervalMs: numberEnv("SCVS_ABUSE_SWEEP_INTERVAL_MS", 300_000),
  stagingSweepJobAgeCeilingMs: numberEnv("SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS", 14_400_000),
  maxSourceArchiveBytes: numberEnv("SCVS_MAX_SOURCE_ARCHIVE_BYTES", 50 * 1024 * 1024),
  abuseWindowMs: numberEnv("SCVS_ABUSE_WINDOW_MS", 60_000),
  // No default: an absent key must fail the boot (env.dto.ts), never fall back to a value every deployment shares.
  abuseFingerprintKey: process.env.SCVS_ABUSE_FINGERPRINT_KEY ?? "",
  abuseCounterRetentionMs: numberEnv("SCVS_ABUSE_COUNTER_RETENTION_MS", 15 * 60_000),
  abuseMaxPerWindow: numberEnv("SCVS_ABUSE_MAX_PER_WINDOW", 18),
  submitAbuseMaxPerWindow: numberEnv("SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW", 6),
  streamAbuseMaxPerWindow: numberEnv("SCVS_STREAM_ABUSE_MAX_PER_WINDOW", 12),
  abuseFailOpenThreshold: numberEnv("SCVS_ABUSE_FAILOPEN_THRESHOLD", 10),
  jobStreamWindowMs: numberEnv("SCVS_JOB_STREAM_WINDOW_MS", 15 * 60_000),
  jobStreamSafetyPollMs: numberEnv("SCVS_JOB_STREAM_SAFETY_POLL_MS", 10_000),
  jobStreamMaxConnectionsPerJob: numberEnv("SCVS_JOB_STREAM_MAX_CONNECTIONS_PER_JOB", 5),
  jobStreamMaxConnectionsPerIp: numberEnv("SCVS_JOB_STREAM_MAX_CONNECTIONS_PER_IP", 10),
  jobStreamMaxConnectionsTotal: numberEnv("SCVS_JOB_STREAM_MAX_CONNECTIONS_TOTAL", 500),
  jobMaxWaitMs: numberEnv("SCVS_JOB_MAX_WAIT_MS", 60 * 60_000),
  activeJobDedupStaleMs: numberEnv("SCVS_ACTIVE_JOB_DEDUP_STALE_MS", 30 * 60_000),
  legalDocumentsSource: process.env.SCVS_LEGAL_DOCUMENTS_SOURCE,
  stellarCliPath: process.env.STELLAR_CLI_PATH || "stellar",
  artifactDir: process.env.SCVS_ARTIFACT_DIR || join(tmpdir(), "scvs-artifacts"),
  cliTimeoutMs: numberEnv("SCVS_CLI_TIMEOUT_MS", 120_000),
  // Unset keeps the CLI's placeholder mainnet entry, so mainnet lookups fail, as a testnet-only deployment wants.
  mainnetRpcUrl: process.env.SCVS_MAINNET_RPC_URL,
});

export default configuration;

export type AppConfig = ReturnType<typeof configuration>;

export type AppConfigService = ConfigService<AppConfig, true>;
