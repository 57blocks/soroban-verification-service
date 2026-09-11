/**
 * DI tokens for what `DbModule.forRootAsync` provides. Kept in their own file so the repositories can import
 * them without importing `db.module.ts`, which imports the repositories.
 */
export const PRISMA_CLIENT = Symbol("SCVS_PRISMA_CLIENT");

/**
 * The resolved connection string. Needed separately by `JobEventsService`, whose LISTEN session must sit
 * outside Prisma's pool while still coming from the same configured source.
 */
export const DB_CONNECTION_STRING = Symbol("SCVS_DB_CONNECTION_STRING");
