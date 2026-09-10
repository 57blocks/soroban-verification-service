import { PrismaPg } from "@prisma/adapter-pg";
import { toConnectionString, type DbConnectionInput } from "@scvs/db";
import { PrismaClient } from "../generated/prisma/client.js";

export { PrismaClient };

/** Builds a `PrismaClient` over an explicitly supplied connection. */
export function createPrismaClient(input: DbConnectionInput): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: toConnectionString(input),
    ...(process.env.NODE_ENV === "test" ? { max: 1 } : {}),
  });
  return new PrismaClient({ adapter });
}
