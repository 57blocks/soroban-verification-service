export const ERROR_SCHEMA = "stellar-verification-error" as const;

export const ERROR_SCHEMA_VERSION = "1.0" as const;

export type ErrorEnvelope = {
  schema: typeof ERROR_SCHEMA;
  schema_version: typeof ERROR_SCHEMA_VERSION;
  error: string;
  message: string;
};

export type ErrorDetail = { error: string; message: string } & Record<string, unknown>;

/** Spread first, so a caller's detail cannot overwrite `schema`/`schema_version`. */
export function errorEnvelope(body: ErrorDetail): ErrorEnvelope & Record<string, unknown> {
  return { ...body, schema: ERROR_SCHEMA, schema_version: ERROR_SCHEMA_VERSION };
}
