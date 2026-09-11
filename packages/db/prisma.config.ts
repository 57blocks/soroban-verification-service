import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";
import { getDatabaseUrl } from "./src/env.js";

// The Prisma CLI runs with cwd = packages/db, so a bare `dotenv/config` only ever saw this package's own .env.
loadDotenv({ quiet: true });
loadDotenv({ path: new URL("../../.env", import.meta.url), quiet: true });

// .env defines discrete POSTGRES_* fields.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: getDatabaseUrl(),
  },
});
