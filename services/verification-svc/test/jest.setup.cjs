// Points every spec at the same local docker-compose Postgres the other services' suites use.
require("../../../packages/db/testing/local-env.cjs");

process.env.NODE_ENV = "test";

/** High enough that no suite can reach it; the guard's own threshold is covered by abuse-guard.spec.ts. */
const NO_QUOTA_IN_TESTS = 1_000_000;

// A drain grace period of 0 for tests.
process.env.SCVS_DRAIN_GRACE_MS ||= "0";

// The suite rate-limits itself without this.
process.env.SCVS_ABUSE_MAX_PER_WINDOW = String(NO_QUOTA_IN_TESTS);

// The submission tier needs the same treatment, and needs it more: its production default is 6 per window, and
// the submit-driving suites issue well over six posts from the one fingerprint every worker shares.
process.env.SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW = String(NO_QUOTA_IN_TESTS);

// The in-process tier needs it too, for the same reason.
process.env.SCVS_THROTTLE_LIMIT = String(NO_QUOTA_IN_TESTS);

// Boot-required: the abuse fingerprint is an HMAC and has no default key. The value is
// irrelevant to what the suites assert, only its presence is.
process.env.SCVS_ABUSE_FINGERPRINT_KEY ||= "test-fingerprint-key";

// Boot-required, and it must resolve: the legal module loads and validates the bundle at init. The
// example is placeholder text with no effective date, so acceptance is optional unless a spec overrides it.
process.env.SCVS_LEGAL_DOCUMENTS_SOURCE ||= "config/legal-documents.example.json";

// Throttler is CommonJS; loading Nest first keeps its require(esm) of @nestjs/common out of a cycle.
require("@nestjs/common");
require("@nestjs/core");
