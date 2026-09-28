// Separate file: the repositories import these, and db.module.ts imports the repositories.
export const PRISMA_CLIENT = Symbol("SCVS_QUERY_PRISMA_CLIENT");

export const DB_CONNECTION_STRING = Symbol("SCVS_QUERY_DB_CONNECTION_STRING");

export const DB_CONNECTION_INPUT = Symbol("SCVS_QUERY_DB_CONNECTION_INPUT");
