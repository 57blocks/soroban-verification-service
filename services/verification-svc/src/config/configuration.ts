import type { ConfigService } from "@nestjs/config";
import { HTTP_TIMEOUT_DEFAULTS } from "@scvs/core";
import { readDbEnv } from "@scvs/db";
import { tmpdir } from "node:os";
import { join } from "node:path";

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** `@nestjs/config`'s single loader for this service. */
const configuration = () => ({
  // O9's drain window: how long we keep serving after SIGTERM so readiness can go false and the balancer can
  // deregister us before we leave.
  drainGraceMs: numberEnv("SCVS_DRAIN_GRACE_MS", 15_000),
  port: numberEnv("PORT", 5000),
  // The three `http.Server` deadlines main.ts applies after listen(). Node's own defaults are not neutral —
  // its 5 s keepAliveTimeout sits below the balancer's idle timeout and answers 502 on a reused connection.
  httpTimeouts: {
    requestTimeoutMs: numberEnv("SCVS_REQUEST_TIMEOUT_MS", HTTP_TIMEOUT_DEFAULTS.requestTimeoutMs),
    headersTimeoutMs: numberEnv("SCVS_HEADERS_TIMEOUT_MS", HTTP_TIMEOUT_DEFAULTS.headersTimeoutMs),
    keepAliveTimeoutMs: numberEnv(
      "SCVS_KEEPALIVE_TIMEOUT_MS",
      HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs,
    ),
    // What keepAliveTimeoutMs is checked against, so the 502 rule holds for a deployment fronted by something
    // other than this one's ALB. `0` says nothing fronts this server and skips the check.
    frontingProxyIdleTimeoutMs: numberEnv(
      "SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS",
      HTTP_TIMEOUT_DEFAULTS.frontingProxyIdleTimeoutMs,
    ),
  },
  // The database connection app.module.ts feeds to DbModule.forRootAsync, so it travels ConfigService like
  // every other setting instead of @scvs/db reading POSTGRES_* off process.env itself. readDbEnv() deliberately
  // does not validate: this loader also runs where no database environment exists (generate-openapi.ts in CI).
  postgres: readDbEnv(),
  serviceVersion: process.env.npm_package_version || "0.1.0",
  uploadRateLimitPerMinute: numberEnv("SCVS_UPLOAD_RATE_LIMIT_PER_MINUTE", 60),
  // The in-process tier's ceiling — `ThrottlerGuard`, applied globally in app.module.ts.
  throttleLimit: numberEnv("SCVS_THROTTLE_LIMIT", 60),
  uploadCleanupIntervalMs: numberEnv("SCVS_UPLOAD_CLEANUP_INTERVAL_MS", 60_000),
  // Anchored against SCVS_ENVIRONMENT_COMPOSE_TIMEOUT_MS's 30-minute default for a *different* job type
  // (composer), scaled up because a verify/build sandbox routinely runs longer (full `cargo vendor` + compile).
  stagingSweepJobAgeCeilingMs: numberEnv("SCVS_STAGING_SWEEP_JOB_AGE_CEILING_MS", 14_400_000),
  maxSourceArchiveBytes: numberEnv("SCVS_MAX_SOURCE_ARCHIVE_BYTES", 50 * 1024 * 1024),
  abuseWindowMs: numberEnv("SCVS_ABUSE_WINDOW_MS", 60_000),
  // No default on purpose: an absent key must be a boot failure, never a fallback that is the same on every
  // deployment and therefore no key at all. `env.dto.ts` is what actually stops the boot.
  abuseFingerprintKey: process.env.SCVS_ABUSE_FINGERPRINT_KEY ?? "",
  // How long a spent counter row outlives its window before the sweep removes it. Counsel's bound is 24h;
  // nothing can read a row outside its own window, so this is the clock-skew margin, not a retention choice.
  abuseCounterRetentionMs: numberEnv("SCVS_ABUSE_COUNTER_RETENTION_MS", 15 * 60_000),
  // Raising one raises a client's total.
  abuseMaxPerWindow: numberEnv("SCVS_ABUSE_MAX_PER_WINDOW", 18),
  submitAbuseMaxPerWindow: numberEnv("SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW", 6),
  // How long ONE `GET /api/verification/v1/verifications/:id/events` connection stays open before the server
  // ends it and lets the browser's EventSource reconnect (jobs.service.ts).
  jobStreamWindowMs: numberEnv("SCVS_JOB_STREAM_WINDOW_MS", 15 * 60_000),
  jobStreamSafetyPollMs: numberEnv("SCVS_JOB_STREAM_SAFETY_POLL_MS", 10_000),
  // How long a job may stay non-terminal before the stream reports `job_timeout`.
  jobMaxWaitMs: numberEnv("SCVS_JOB_MAX_WAIT_MS", 60 * 60_000),
  // How long a non-terminal job keeps deduplicating new submissions for its target (submit.service.ts ->
  // JobsRepository.getActiveJobForTarget).
  activeJobDedupStaleMs: numberEnv("SCVS_ACTIVE_JOB_DEDUP_STALE_MS", 30 * 60_000),
  // No default: an unset value is a boot failure, because this service serves the operator's legal
  // documents and ships none of its own (versioned-terms-and-assent design.md TA-4).
  legalDocumentsSource: process.env.SCVS_LEGAL_DOCUMENTS_SOURCE,
  stellarCliPath: process.env.STELLAR_CLI_PATH || "stellar",
  artifactDir: process.env.SCVS_ARTIFACT_DIR || join(tmpdir(), "scvs-artifacts"),
  cliTimeoutMs: numberEnv("SCVS_CLI_TIMEOUT_MS", 120_000),
  // Optional: mainnet chain lookups only. Unset keeps the CLI's built-in mainnet entry, which is a docs
  // placeholder and fails any mainnet fetch — that is what a testnet-only deployment wants.
  mainnetRpcUrl: process.env.SCVS_MAINNET_RPC_URL,
});

export default configuration;

/** The exact shape this service's loader produces. */
export type AppConfig = ReturnType<typeof configuration>;

/** Inject this instead of the bare `ConfigService`. The DI token is still `ConfigService`. */
export type AppConfigService = ConfigService<AppConfig, true>;
