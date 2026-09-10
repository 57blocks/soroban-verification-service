/**
 * The `.json`-suffixed spellings of the three dynamic read routes, kept alive while the Trusted Verifiers Lists
 * that name them are re-seeded.
 */
export const JSON_ROUTE_SUNSET_DATE = "2026-12-01";

/** RFC 9110 HTTP-date, the only form RFC 8594's `Sunset` header takes. */
export const JSON_ROUTE_SUNSET_HTTP_DATE = "Mon, 01 Dec 2026 00:00:00 GMT";

/** Shown in the OpenAPI document, where a consumer generating a client is most likely to read it. */
export const DEPRECATED_JSON_ROUTE_DESCRIPTION =
  `Deprecated spelling, removed after ${JSON_ROUTE_SUNSET_DATE}. ` +
  "Identical to the route without the `.json` suffix; TRD §5.7 reserves the suffix for documents a " +
  "static origin serves as-is.";
