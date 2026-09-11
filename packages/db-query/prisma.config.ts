import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";
import { getDatabaseUrl } from "@scvs/db";

// Same loading order as packages/db/prisma.config.ts, and for the same reason: the Prisma CLI runs with cwd =
// packages/db-query, so a bare `dotenv/config` only ever sees this package's own .env.
loadDotenv({ quiet: true });
loadDotenv({ path: new URL("../../.env", import.meta.url), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: getDatabaseUrl(),
  },
});
