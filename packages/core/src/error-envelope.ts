/**
 * In `packages/core` because both services need it. Two constants in two `common/` folders is how
 * `schema_version` came to exist on verification-svc's envelope and not on query-svc's at all.
 */
export const ERROR_SCHEMA = "stellar-verification-error" as const;

/** Version of the envelope itself, not of the API. */
export const ERROR_SCHEMA_VERSION = "1.0" as const;

/** The four fields every error body carries, whatever else a route adds. */
export type ErrorEnvelope = {
  schema: typeof ERROR_SCHEMA;
  schema_version: typeof ERROR_SCHEMA_VERSION;
  error: string;
  message: string;
};

/** What a caller supplies: the code and the sentence, plus whatever diagnostic detail it has. */
export type ErrorDetail = { error: string; message: string } & Record<string, unknown>;

/**
 * Stamps the two identifiers onto a caller's detail. They go **after** the spread deliberately: `ErrorDetail`'s
 * index signature would otherwise let a caller overwrite the two things this envelope exists to guarantee.
 */
export function errorEnvelope(body: ErrorDetail): ErrorEnvelope & Record<string, unknown> {
  return { ...body, schema: ERROR_SCHEMA, schema_version: ERROR_SCHEMA_VERSION };
}
