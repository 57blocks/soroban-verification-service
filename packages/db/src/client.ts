import { PrismaPg } from "@prisma/adapter-pg";
import { toConnectionString, type DbConnectionInput } from "./connection.js";
import { PrismaClient } from "../generated/prisma/client.js";

export { PrismaClient };

/** Builds a `PrismaClient` over an explicitly supplied connection. */
export function createPrismaClient(input: DbConnectionInput): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: toConnectionString(input),
    // Turborepo runs service suites together and Jest runs each service across workers.
    ...(process.env.NODE_ENV === "test" ? { max: 1 } : {}),
  });
  return new PrismaClient({ adapter });
}
