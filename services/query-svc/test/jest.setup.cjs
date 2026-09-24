const path = require("node:path");

// Same local Postgres as verification-svc's baseline suite (GET /verifiers reads trusted_verifiers via
// @scvs/db-query).
process.env.POSTGRES_HOST ||= "localhost";
process.env.POSTGRES_PORT ||= "5433";
process.env.POSTGRES_DB ||= "scvs";
process.env.POSTGRES_USER ||= "scvs";
process.env.POSTGRES_PASSWORD ||= "scvs_local_dev";
process.env.PORT ||= "4999";
process.env.SCVS_PUBLISHER_STORAGE ||= "filesystem";
// No background sync in a route test: its first pass would touch Prisma between tests, which Jest refuses, and
// every spec that needs the aggregation drives it explicitly instead.
process.env.SCVS_AGGREGATION_SYNC_INTERVAL_MS ||= "0";

// A fresh published-result tree per Jest worker, seeded by results.spec.ts through the real
// `@scvs/storage-layout` publisher (see its `beforeAll`).
const { mkdtempSync } = require("node:fs");
const os = require("node:os");

process.env.SCVS_RESULT_ROOT ||= mkdtempSync(
  path.join(os.tmpdir(), "scvs-query-svc-results-")
);
process.env.SCVS_PUBLIC_RESULT_ROOT ||= "http://localhost:4999";
// The fetch-policy opt-out is deliberately not set here: only aggregate.spec.ts needs it, and suite-wide would
// mean no spec ever runs against the strict default.

// Every worker shares one caller address (127.0.0.1), so the suite rate-limits itself without this. Both tiers
// need it: aggregation.spec.ts drives the address route too. `rate-limit.spec.ts` sets its own ceilings rather
// than relying on these, which is why raising them here hides nothing.
// The address tier must stay strictly below the global one or boot fails by design, so the two differ here
// too — equal ceilings are exactly what configuration.ts refuses.
const NO_QUOTA_IN_TESTS = 1_000_000;
process.env.SCVS_QUERY_THROTTLE_LIMIT ||= String(NO_QUOTA_IN_TESTS * 2);
process.env.SCVS_QUERY_ADDRESS_THROTTLE_LIMIT ||= String(NO_QUOTA_IN_TESTS);

process.env.NODE_ENV = "test";

// A drain grace period of 0 for tests.
process.env.SCVS_DRAIN_GRACE_MS ||= "0";

// Throttler is CommonJS; loading Nest first keeps its require(esm) of @nestjs/common out of a cycle.
require("@nestjs/common");
require("@nestjs/core");
