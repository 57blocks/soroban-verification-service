export type PostgresConnectionConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

export type PoolTuning = {
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  max?: number;
};

export type DbConnectionInput =
  | ({ url: string } & PoolTuning)
  | (Partial<PostgresConnectionConfig> & PoolTuning);

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

/** Zero is dropped, except idleTimeoutMillis, where 0 is pg's documented "never evict". */
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
  // @prisma/adapter-pg treats sslmode=require as verify-full, which rejects RDS's self-signed certificate.
  const sslMode =
    process.env.POSTGRES_SSL === "true"
      ? "?sslmode=require&uselibpqcompat=true"
      : "";
  return `postgresql://${encodedUser}:${encodedPassword}@${host || "localhost"}:${port || 5433}/${database}${sslMode}`;
}
