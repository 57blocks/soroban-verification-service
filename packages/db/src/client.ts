import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";
import { toConnectionString, type DbConnectionInput } from "./connection.js";
import { PrismaClient } from "../generated/prisma/client.js";

export { PrismaClient };

/** pg's default of 0 waits forever for a connection. */
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

export function resolvePoolConfig(input: DbConnectionInput): PoolConfig {
  return {
    connectionString: toConnectionString(input),
    connectionTimeoutMillis: input.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: input.idleTimeoutMillis,
    // Suites run in parallel across services and Jest workers, so each test client takes one connection.
    ...(process.env.NODE_ENV === "test" ? { max: 1 } : { max: input.max }),
  };
}

export function createPrismaClient(input: DbConnectionInput): PrismaClient {
  const adapter = new PrismaPg(resolvePoolConfig(input));
  return new PrismaClient({ adapter });
}
