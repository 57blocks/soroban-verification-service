import type { ConfigService } from "@nestjs/config";
import { readDbEnv } from "@scvs/db-query";
import { HTTP_TIMEOUT_DEFAULTS, MAX_BULK_LIMIT, MIN_BULK_LIMIT } from "@scvs/core";

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Unlike `numberEnv`, out-of-range is a boot error, not a silent fallback: a limit outside [MIN_BULK_LIMIT,
 * MAX_BULK_LIMIT] is a value every conformant peer's bulk-load route would refuse (BL3), so accepting it here
 * would defer the failure to the first sync tick instead of catching it at boot, where `env.dto.ts`'s other
 * checks already report configuration mistakes.
 */
function boundedBulkPageLimit(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; got "${value}"`);
  }
  return parsed;
}

const configuration = () => ({
  // O9's drain window: how long we keep serving after SIGTERM so readiness can go false and the balancer can
  // deregister us before we leave.
  drainGraceMs: numberEnv("SCVS_DRAIN_GRACE_MS", 15_000),
  port: numberEnv("PORT", 5001),
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
  // every other setting instead of a package reading POSTGRES_* off process.env itself.
  postgres: readDbEnv(),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  queryTimeoutMs: numberEnv("SCVS_QUERY_TIMEOUT_MS", 5_000),
  queryCacheTtlMs: numberEnv("SCVS_QUERY_CACHE_TTL_MS", 30_000),
  // How often the retained aggregation is refreshed. Zero disables the timer entirely, for a deployment driving
  // the sync some other way and for tests.
  aggregationSyncIntervalMs: numberEnv("SCVS_AGGREGATION_SYNC_INTERVAL_MS", 60_000),
  // Records requested per page when paging a verifier's own bulk-load stream (discover()).
  bulkPageLimit: boundedBulkPageLimit("SCVS_BULK_PAGE_LIMIT", MAX_BULK_LIMIT, MIN_BULK_LIMIT, MAX_BULK_LIMIT),
  rpcTimeoutMs: numberEnv("SCVS_RPC_TIMEOUT_MS", 5_000),
  stellarRpcUrlTestnet: process.env.STELLAR_RPC_URL_TESTNET || "https://soroban-testnet.stellar.org",
  // No default: SDF hosts no public mainnet endpoint, so an operator serving mainnet supplies one.
  stellarRpcUrlMainnet: process.env.STELLAR_RPC_URL_MAINNET || "",
  // `env.dto.ts` rejects anything but "true"/"false" at boot, so this comparison is the whole parse.
  allowInsecureResultRoots: process.env.SCVS_QUERY_ALLOW_INSECURE_RESULT_ROOTS === "true",
});

export default configuration;

/** The exact shape this service's loader produces. */
export type AppConfig = ReturnType<typeof configuration>;

/** Inject this instead of the bare `ConfigService`. The DI token is still `ConfigService`. */
export type AppConfigService = ConfigService<AppConfig, true>;
