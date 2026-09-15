import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";
import { toConnectionString, type DbConnectionInput } from "@scvs/db";
import { PrismaClient } from "../generated/prisma/client.js";

export { PrismaClient };

/** Same default and same rationale as `@scvs/db`'s own `client.ts` — see its comment. */
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/** Same reason as `@scvs/db`'s own `resolvePoolConfig` — kept testable without a real Prisma engine. */
export function resolvePoolConfig(input: DbConnectionInput): PoolConfig {
  return {
    connectionString: toConnectionString(input),
    connectionTimeoutMillis: input.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: input.idleTimeoutMillis,
    ...(process.env.NODE_ENV === "test" ? { max: 1 } : { max: input.max }),
  };
}

/** Builds a `PrismaClient` over an explicitly supplied connection. */
export function createPrismaClient(input: DbConnectionInput): PrismaClient {
  const adapter = new PrismaPg(resolvePoolConfig(input));
  return new PrismaClient({ adapter });
}
