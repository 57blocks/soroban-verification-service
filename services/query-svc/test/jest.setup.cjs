const path = require("node:path");

process.env.POSTGRES_HOST ||= "localhost";
process.env.POSTGRES_PORT ||= "5433";
process.env.POSTGRES_DB ||= "scvs";
process.env.POSTGRES_USER ||= "scvs";
process.env.POSTGRES_PASSWORD ||= "scvs_local_dev";
process.env.PORT ||= "4999";
process.env.SCVS_PUBLISHER_STORAGE ||= "filesystem";
process.env.SCVS_AGGREGATION_SYNC_INTERVAL_MS ||= "0";

const { mkdtempSync } = require("node:fs");
const os = require("node:os");

process.env.SCVS_RESULT_ROOT ||= mkdtempSync(
  path.join(os.tmpdir(), "scvs-query-svc-results-")
);
process.env.SCVS_PUBLIC_RESULT_ROOT ||= "http://localhost:4999";

// The address tier must stay below the global one or boot fails.
const NO_QUOTA_IN_TESTS = 1_000_000;
process.env.SCVS_QUERY_THROTTLE_LIMIT ||= String(NO_QUOTA_IN_TESTS * 2);
process.env.SCVS_QUERY_ADDRESS_THROTTLE_LIMIT ||= String(NO_QUOTA_IN_TESTS);

process.env.NODE_ENV = "test";

process.env.SCVS_DRAIN_GRACE_MS ||= "0";

// Load Nest before the CommonJS throttler so its require(esm) of @nestjs/common does not cycle.
require("@nestjs/common");
require("@nestjs/core");
