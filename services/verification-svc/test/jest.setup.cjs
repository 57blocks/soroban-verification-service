require("../../../packages/db/testing/local-env.cjs");

process.env.NODE_ENV = "test";

const NO_QUOTA_IN_TESTS = 1_000_000;

process.env.SCVS_DRAIN_GRACE_MS ||= "0";

process.env.SCVS_ABUSE_MAX_PER_WINDOW = String(NO_QUOTA_IN_TESTS);

process.env.SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW = String(NO_QUOTA_IN_TESTS);

process.env.SCVS_THROTTLE_LIMIT = String(NO_QUOTA_IN_TESTS);

process.env.SCVS_ABUSE_FINGERPRINT_KEY ||= "test-fingerprint-key";

process.env.SCVS_LEGAL_DOCUMENTS_SOURCE ||= "config/legal-documents.example.json";

// Throttler is CommonJS; loading Nest first keeps its require(esm) of @nestjs/common out of a cycle.
require("@nestjs/common");
require("@nestjs/core");
