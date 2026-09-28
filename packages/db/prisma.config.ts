import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";
import { getDatabaseUrl } from "./src/env.js";

// The Prisma CLI runs with cwd = this package, so the root .env is loaded explicitly.
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
