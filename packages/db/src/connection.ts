export type PostgresConnectionConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

/** Either a ready-made connection string or the discrete fields to build one from. */
export type DbConnectionInput =
  | { url: string }
  | Partial<PostgresConnectionConfig>;

/**
 * Reads the database environment **without validating it**, for a service's `config/configuration.ts` to expose
 * as its `postgres` key.
 */
export function readDbEnv(): DbConnectionInput {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL };
  const port = Number(process.env.POSTGRES_PORT);
  return {
    host: process.env.POSTGRES_HOST || "localhost",
    port: Number.isFinite(port) && port > 0 ? port : 5433,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
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
