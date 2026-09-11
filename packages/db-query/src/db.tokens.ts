/**
 * DI tokens for what `DbModule.forRootAsync` provides. Kept in their own file so the repositories can import
 * them without importing `db.module.ts`, which imports the repositories.
 */
export const PRISMA_CLIENT = Symbol("SCVS_QUERY_PRISMA_CLIENT");

/** The resolved connection string for this package's own database. */
export const DB_CONNECTION_STRING = Symbol("SCVS_QUERY_DB_CONNECTION_STRING");
