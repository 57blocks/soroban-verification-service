import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";
import { toConnectionString, type DbConnectionInput } from "./connection.js";
import { PrismaClient } from "../generated/prisma/client.js";

export { PrismaClient };

/**
 * `pg`'s own default is `0` — an acquire request waits forever rather than failing fast. Pool exhaustion
 * then degrades into unbounded queuing instead of an observable error, which is worse than picking any
 * finite number. Overridable via `SCVS_DB_CONNECTION_TIMEOUT_MS` (see `readPoolTuningEnv` in connection.ts).
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Separated from `createPrismaClient` so a test can assert on the resolved pool config without constructing a
 * real `PrismaClient` (which requires a real Prisma engine) or mocking `@prisma/adapter-pg`.
 */
export function resolvePoolConfig(input: DbConnectionInput): PoolConfig {
  return {
    connectionString: toConnectionString(input),
    connectionTimeoutMillis: input.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: input.idleTimeoutMillis,
    // Turborepo runs service suites together and Jest runs each service across workers.
    ...(process.env.NODE_ENV === "test" ? { max: 1 } : { max: input.max }),
  };
}

/** Builds a `PrismaClient` over an explicitly supplied connection. */
export function createPrismaClient(input: DbConnectionInput): PrismaClient {
  const adapter = new PrismaPg(resolvePoolConfig(input));
  return new PrismaClient({ adapter });
}
