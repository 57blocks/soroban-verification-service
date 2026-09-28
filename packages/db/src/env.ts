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

export function getDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { host, port, database, user, password } = getPostgresConfig();
  // @prisma/adapter-pg treats sslmode=require as verify-full, which rejects RDS's self-signed certificate.
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
