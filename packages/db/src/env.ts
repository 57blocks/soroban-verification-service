export type PostgresConnectionConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

export function getPostgresConfig(): PostgresConnectionConfig {
  return {
    host: process.env.POSTGRES_HOST || "localhost",
    port: Number(process.env.POSTGRES_PORT) || 5433,
    database: requireEnv("POSTGRES_DB"),
    user: requireEnv("POSTGRES_USER"),
    password: requireEnv("POSTGRES_PASSWORD"),
  };
}

/** .env defines the discrete POSTGRES_* fields. */
export function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { host, port, database, user, password } = getPostgresConfig();
  // `sslmode=require` is treated as `verify-full` by @prisma/adapter-pg, which validates RDS's self-signed
  // server cert and fails; the libpq-compat flag restores "encrypt but don't validate".
  const sslMode =
    process.env.POSTGRES_SSL === "true" ? "sslmode=require&uselibpqcompat=true" : "sslmode=disable";
  const url = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}?${sslMode}`;
  process.env.DATABASE_URL = url;
  return url;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required — see packages/db/.env.example.`);
  return value;
}
