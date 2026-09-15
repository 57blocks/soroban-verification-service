import {
  readDbEnv,
  resolvePoolConfig,
  toConnectionString,
  type PostgresConnectionConfig,
} from "@scvs/db";

/**
 * Guards the two precedence rules that broke while `packages/db`'s connection was being moved off ambient
 * `process.env`.
 */

const DB_KEYS = [
  "DATABASE_URL",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "SCVS_DB_CONNECTION_TIMEOUT_MS",
  "SCVS_DB_IDLE_TIMEOUT_MS",
  "SCVS_DB_POOL_MAX",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(DB_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  for (const key of DB_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("readDbEnv", () => {
  it("lets DATABASE_URL short-circuit the five discrete POSTGRES_* variables", () => {
    // Assembling the discrete fields first would invert it, and every deployment sets both, so nothing would
    // visibly break — the service would just quietly talk to the wrong database.
    process.env.DATABASE_URL = "postgresql://u:p@example.invalid:5432/from_url";
    process.env.POSTGRES_DB = "from_discrete_fields";
    process.env.POSTGRES_USER = "u";
    process.env.POSTGRES_PASSWORD = "p";

    expect(readDbEnv()).toEqual({
      url: "postgresql://u:p@example.invalid:5432/from_url",
    });
  });

  it("falls back to the discrete variables when DATABASE_URL is unset", () => {
    delete process.env.DATABASE_URL;
    process.env.POSTGRES_HOST = "db.example.invalid";
    process.env.POSTGRES_PORT = "6000";
    process.env.POSTGRES_DB = "scvs";
    process.env.POSTGRES_USER = "u";
    process.env.POSTGRES_PASSWORD = "p";

    expect(readDbEnv()).toEqual({
      host: "db.example.invalid",
      port: 6000,
      database: "scvs",
      user: "u",
      password: "p",
    });
  });

  it("reports a partial config rather than throwing when nothing is set", () => {
    // generate-openapi.ts boots the real Nest app in CI with no database environment at all, so this loader
    // must not throw.
    for (const key of DB_KEYS) delete process.env[key];

    const config = readDbEnv() as Partial<PostgresConnectionConfig>;
    expect(config.database).toBeUndefined();
    expect(config.host).toBe("localhost");
  });

  it("merges the pool-tuning variables in alongside a discrete-field config", () => {
    for (const key of DB_KEYS) delete process.env[key];
    process.env.POSTGRES_HOST = "db.example.invalid";
    process.env.SCVS_DB_CONNECTION_TIMEOUT_MS = "9000";
    process.env.SCVS_DB_IDLE_TIMEOUT_MS = "30000";
    process.env.SCVS_DB_POOL_MAX = "20";

    expect(readDbEnv()).toMatchObject({
      host: "db.example.invalid",
      connectionTimeoutMillis: 9000,
      idleTimeoutMillis: 30000,
      max: 20,
    });
  });

  it("merges the pool-tuning variables in alongside a DATABASE_URL config", () => {
    for (const key of DB_KEYS) delete process.env[key];
    process.env.DATABASE_URL = "postgresql://u:p@example.invalid:5432/from_url";
    process.env.SCVS_DB_CONNECTION_TIMEOUT_MS = "9000";

    expect(readDbEnv()).toEqual({
      url: "postgresql://u:p@example.invalid:5432/from_url",
      connectionTimeoutMillis: 9000,
    });
  });

  it("omits a pool-tuning field rather than passing NaN when its variable is unset, non-numeric, or non-positive", () => {
    for (const key of DB_KEYS) delete process.env[key];
    process.env.SCVS_DB_CONNECTION_TIMEOUT_MS = "not-a-number";
    process.env.SCVS_DB_IDLE_TIMEOUT_MS = "0";
    // SCVS_DB_POOL_MAX left unset entirely.

    const config = readDbEnv();
    expect(config).not.toHaveProperty("connectionTimeoutMillis");
    expect(config).not.toHaveProperty("idleTimeoutMillis");
    expect(config).not.toHaveProperty("max");
  });
});

describe("toConnectionString", () => {
  // This is where "does this process actually need a database?" gets answered, which is why the Postgres
  // variables are absent from `ConfigModule`'s validate schema: `DbModule`'s factory reaches this and fails at
  // startup, while `generate-openapi.ts` boots the same AppModule in CI without a database and never reaches
  // it.
  it("throws and names every missing field when the config is incomplete", () => {
    expect(() => toConnectionString({ host: "localhost", port: 5433 })).toThrow(
      /missing POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD/,
    );
  });

  it("names only the fields that are actually missing", () => {
    expect(() =>
      toConnectionString({ database: "scvs", user: "scvs", host: "localhost", port: 5433 }),
    ).toThrow(/missing POSTGRES_PASSWORD/);
  });

  it("passes a url straight through", () => {
    expect(toConnectionString({ url: "postgresql://u:p@h:1/d" })).toBe(
      "postgresql://u:p@h:1/d",
    );
  });

  it("percent-encodes credentials when assembling from discrete fields", () => {
    // A password with a `@` or `/` in it would otherwise produce a connection string that parses into a
    // different host or database entirely.
    expect(
      toConnectionString({
        host: "db.example.invalid",
        port: 5432,
        database: "scvs",
        user: "user@" + "corp",
        password: "p@ss/" + "word",
      }),
    ).toBe("postgresql://user%40corp:p%40ss%2Fword@db.example.invalid:5432/scvs");
  });
});

describe("resolvePoolConfig", () => {
  // Asserts on the config createPrismaClient would hand `PrismaPg`, without constructing a real
  // PrismaClient (which needs a real Prisma engine) or mocking @prisma/adapter-pg.
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("defaults connectionTimeoutMillis to 5000ms when the input supplies none", () => {
    process.env.NODE_ENV = "production";
    expect(resolvePoolConfig({ url: "postgresql://u:p@h:1/d" })).toMatchObject({
      connectionTimeoutMillis: 5000,
    });
  });

  it("passes an explicit connectionTimeoutMillis, idleTimeoutMillis, and max straight through", () => {
    process.env.NODE_ENV = "production";
    expect(
      resolvePoolConfig({
        url: "postgresql://u:p@h:1/d",
        connectionTimeoutMillis: 9000,
        idleTimeoutMillis: 30000,
        max: 20,
      }),
    ).toMatchObject({ connectionTimeoutMillis: 9000, idleTimeoutMillis: 30000, max: 20 });
  });

  it("forces max to 1 under NODE_ENV=test regardless of what the input asked for", () => {
    process.env.NODE_ENV = "test";
    expect(resolvePoolConfig({ url: "postgresql://u:p@h:1/d", max: 20 })).toMatchObject({
      max: 1,
    });
  });
});
