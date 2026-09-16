const path = require("node:path");

// Points every spec at the same local docker-compose Postgres the other services' suites use — the root `.env`
// first, then the compose defaults.
require("../../../packages/db/testing/local-env.cjs");

// A writable per-worker result tree, so anything that publishes during a test writes somewhere real and
// disposable.
const { mkdtempSync } = require("node:fs");
const os = require("node:os");

process.env.SCVS_PUBLISHER_STORAGE ||= "filesystem";
process.env.SCVS_RESULT_ROOT ||= mkdtempSync(
  path.join(os.tmpdir(), "scvs-orchestrator-results-")
);
process.env.SCVS_PUBLIC_RESULT_ROOT ||= "http://localhost:4999";
// The filesystem backend cannot make a conditional write hold across processes (rule 37), so it refuses to
// boot without this. A test process is a single writer by construction, and each worker has its own tree.
process.env.SCVS_SINGLE_WRITER ||= "true";
// In this test, only the config object's shape matters (nothing here calls S3), so a placeholder value
// satisfies the presence check without needing real AWS credentials.
process.env.SCVS_STORAGE_BUCKET ||= "test-fixture-bucket";
// SCVS_JOB_STATE_CHANGE_QUEUE_URL is required the same way (see batch-event-consumer.service.ts's
// onModuleInit).
process.env.AWS_ENDPOINT_URL_SQS ||= "http://127.0.0.1:1";
process.env.AWS_ACCESS_KEY_ID ||= "test";
process.env.AWS_SECRET_ACCESS_KEY ||= "test";
process.env.AWS_REGION ||= "us-east-1";
process.env.SCVS_JOB_STATE_CHANGE_QUEUE_URL ||=
  "http://127.0.0.1:1/000000000000/test-queue";
process.env.NODE_ENV = "test";

// A drain grace period of 0 for tests.
process.env.SCVS_DRAIN_GRACE_MS ||= "0";
