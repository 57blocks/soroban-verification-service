import type { ConfigService } from "@nestjs/config";
import { readDbEnv } from "@scvs/db-query";
import { HTTP_TIMEOUT_DEFAULTS, MAX_BULK_LIMIT, MIN_BULK_LIMIT } from "@scvs/core";

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boundedBulkPageLimit(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; got "${value}"`);
  }
  return parsed;
}

export const DEFAULT_ADDRESS_THROTTLE_LIMIT = 60;

function queryThrottleLimit(): number {
  const globalLimit = numberEnv("SCVS_QUERY_THROTTLE_LIMIT", 600);
  assertTierOrdering(globalLimit, addressThrottleLimit());
  return globalLimit;
}

export function addressThrottleLimit(): number {
  return numberEnv("SCVS_QUERY_ADDRESS_THROTTLE_LIMIT", DEFAULT_ADDRESS_THROTTLE_LIMIT);
}

function assertTierOrdering(globalLimit: number, addressLimit: number): void {
  if (addressLimit < globalLimit) return;
  throw new Error(
    `SCVS_QUERY_ADDRESS_THROTTLE_LIMIT (${addressLimit}) must be below SCVS_QUERY_THROTTLE_LIMIT ` +
      `(${globalLimit}): it replaces the global budget for the address route rather than stacking under it, ` +
      "so this value widens that route instead of narrowing it.",
  );
}

const configuration = () => ({
  drainGraceMs: numberEnv("SCVS_DRAIN_GRACE_MS", 15_000),
  port: numberEnv("PORT", 5001),
  // Node's default 5 s keepAliveTimeout is below the ALB idle timeout and answers 502 on a reused connection.
  httpTimeouts: {
    requestTimeoutMs: numberEnv("SCVS_REQUEST_TIMEOUT_MS", HTTP_TIMEOUT_DEFAULTS.requestTimeoutMs),
    headersTimeoutMs: numberEnv("SCVS_HEADERS_TIMEOUT_MS", HTTP_TIMEOUT_DEFAULTS.headersTimeoutMs),
    keepAliveTimeoutMs: numberEnv(
      "SCVS_KEEPALIVE_TIMEOUT_MS",
      HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs,
    ),
    // `0` means nothing fronts this server and skips the keep-alive check.
    frontingProxyIdleTimeoutMs: numberEnv(
      "SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS",
      HTTP_TIMEOUT_DEFAULTS.frontingProxyIdleTimeoutMs,
    ),
  },
  postgres: readDbEnv(),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  queryThrottleLimit: queryThrottleLimit(),
  addressThrottleLimit: addressThrottleLimit(),
  // Must stay below the load balancer's health-check timeout.
  readinessDbTimeoutMs: numberEnv("SCVS_READINESS_DB_TIMEOUT_MS", 2_000),
  queryTimeoutMs: numberEnv("SCVS_QUERY_TIMEOUT_MS", 5_000),
  queryCacheTtlMs: numberEnv("SCVS_QUERY_CACHE_TTL_MS", 30_000),
  // `0` disables the timer.
  aggregationSyncIntervalMs: numberEnv("SCVS_AGGREGATION_SYNC_INTERVAL_MS", 60_000),
  bulkPageLimit: boundedBulkPageLimit("SCVS_BULK_PAGE_LIMIT", MAX_BULK_LIMIT, MIN_BULK_LIMIT, MAX_BULK_LIMIT),
  rpcTimeoutMs: numberEnv("SCVS_RPC_TIMEOUT_MS", 5_000),
  stellarRpcUrlTestnet: process.env.STELLAR_RPC_URL_TESTNET || "https://soroban-testnet.stellar.org",
  stellarRpcUrlMainnet: process.env.STELLAR_RPC_URL_MAINNET || "",
  allowInsecureResultRoots: process.env.SCVS_QUERY_ALLOW_INSECURE_RESULT_ROOTS === "true",
  // The pinned transport bypasses `globalThis.fetch`, so a test double stubbing fetch needs this off.
  pinDnsResolution: process.env.SCVS_QUERY_PIN_DNS_RESOLUTION !== "false",
});

export default configuration;

export type AppConfig = ReturnType<typeof configuration>;

export type AppConfigService = ConfigService<AppConfig, true>;
