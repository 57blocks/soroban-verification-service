/**
 * The HTTP error contract both public APIs answer with, in one place.
 *
 * `error-envelope.ts` in `@scvs/core` already says why: two constants in two `common/` folders is how
 * `schema_version` came to exist on one service's envelope and not on the other's. The same thing then
 * happened to `status_code` — required in one service's DTO, optional in the other's, for a field
 * `errorBody` has always set unconditionally.
 *
 * What is **not** here, and why: `not-found.controller.ts` answers a different message per service and both
 * are asserted by tests; `modules/health` reads a different `DbHealthService` from a different package per
 * service. Neither is duplication.
 */

export * from "./api-error.js";
export * from "./api-error.dto.js";
export * from "./legacy-http-exception.filter.js";
