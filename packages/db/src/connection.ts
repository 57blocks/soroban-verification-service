export type PostgresConnectionConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

/**
 * `pg.Pool` behavior, not connection identity — kept separate from `PostgresConnectionConfig` so
 * `toConnectionString` can keep ignoring it. All optional: an absent field means "let `pg` use its own
 * default", not zero, so a caller with no opinion gets `pg`'s behavior rather than this package's.
 */
export type PoolTuning = {
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  max?: number;
};

/** Either a ready-made connection string or the discrete fields to build one from, plus optional pool tuning. */
export type DbConnectionInput =
  | ({ url: string } & PoolTuning)
  | (Partial<PostgresConnectionConfig> & PoolTuning);

/**
 * Reads the database environment **without validating it**, for a service's `config/configuration.ts` to expose
 * as its `postgres` key.
 */
export function readDbEnv(): DbConnectionInput {
  const poolTuning = readPoolTuningEnv();
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, ...poolTuning };
  const port = Number(process.env.POSTGRES_PORT);
  return {
    host: process.env.POSTGRES_HOST || "localhost",
    port: Number.isFinite(port) && port > 0 ? port : 5433,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    ...poolTuning,
  };
}

/**
 * A present-but-non-numeric override is dropped rather than passed through as `NaN` — see `client.ts` for the
 * default. `connectionTimeoutMillis`/`max` of `0` are dropped too (neither has a usable zero value — `0` on
 * `pg`'s own `connectionTimeoutMillis` means unbounded wait, the exact default this package overrides).
 * `idleTimeoutMillis` is the one field where `0` is `pg`'s own documented value ("never evict an idle client")
 * rather than an error, so it alone is accepted at `0`.
 */
function readPoolTuningEnv(): PoolTuning {
  const connectionTimeoutMillis = Number(process.env.SCVS_DB_CONNECTION_TIMEOUT_MS);
  const idleTimeoutMillis = Number(process.env.SCVS_DB_IDLE_TIMEOUT_MS);
  const max = Number(process.env.SCVS_DB_POOL_MAX);
  return {
    ...(Number.isFinite(connectionTimeoutMillis) && connectionTimeoutMillis > 0 ? { connectionTimeoutMillis } : {}),
    ...(Number.isFinite(idleTimeoutMillis) && idleTimeoutMillis >= 0 ? { idleTimeoutMillis } : {}),
    ...(Number.isFinite(max) && max > 0 ? { max } : {}),
  };
}

/** Resolves an input to a connection string, or throws naming every missing variable. */
export function toConnectionString(input: DbConnectionInput): string {
  if ("url" in input && input.url) return input.url;

  const { host, port, database, user, password } =
    input as Partial<PostgresConnectionConfig>;

  const missing = (
    [
      ["POSTGRES_DB", database],
      ["POSTGRES_USER", user],
      ["POSTGRES_PASSWORD", password],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Database configuration is incomplete — missing ${missing.join(", ")}. ` +
        `Set them (or DATABASE_URL, which supersedes all five) in the repository root .env; ` +
        `see .env.example.`,
    );
  }

  const encodedUser = encodeURIComponent(user!);
  const encodedPassword = encodeURIComponent(password!);
  // `@prisma/adapter-pg` treats `sslmode=require` as `verify-full`, which validates RDS's self-signed server
  // certificate and fails with "TLS connection: self-signed certificate in certificate chain".
  const sslMode =
    process.env.POSTGRES_SSL === "true"
      ? "?sslmode=require&uselibpqcompat=true"
      : "";
  return `postgresql://${encodedUser}:${encodedPassword}@${host || "localhost"}:${port || 5433}/${database}${sslMode}`;
}
