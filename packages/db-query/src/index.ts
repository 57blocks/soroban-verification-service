// `readDbEnv`/`toConnectionString`/`getDatabaseUrl`/`DbConnectionInput` are re-exported from `@scvs/db` rather
// than duplicated: they read raw `process.env.POSTGRES_*` with no schema dependency, so there is exactly one
// implementation of "how discrete Postgres env vars become a connection", shared by both packages.
export { readDbEnv, toConnectionString, getDatabaseUrl, type DbConnectionInput } from "@scvs/db";

export * from "./client.js";
export * from "./db.module.js";
export * from "./db.tokens.js";
export * from "./db-health.service.js";
export * from "./trusted-verifiers.repo.js";
export * from "./aggregation.repo.js";
