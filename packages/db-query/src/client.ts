import { PrismaPg } from "@prisma/adapter-pg";
import { resolvePoolConfig, type DbConnectionInput } from "@scvs/db";
import { PrismaClient } from "../generated/prisma/client.js";

export { PrismaClient };
export { resolvePoolConfig };

/** Builds a `PrismaClient` over an explicitly supplied connection. */
export function createPrismaClient(input: DbConnectionInput): PrismaClient {
  const adapter = new PrismaPg(resolvePoolConfig(input));
  return new PrismaClient({ adapter });
}
