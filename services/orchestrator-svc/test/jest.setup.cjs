const path = require("node:path");

require("../../../packages/db/testing/local-env.cjs");

const { mkdtempSync } = require("node:fs");
const os = require("node:os");

process.env.SCVS_PUBLISHER_STORAGE ||= "filesystem";
process.env.SCVS_RESULT_ROOT ||= mkdtempSync(
  path.join(os.tmpdir(), "scvs-orchestrator-results-")
);
process.env.SCVS_PUBLIC_RESULT_ROOT ||= "http://localhost:4999";
process.env.SCVS_SINGLE_WRITER ||= "true";
process.env.SCVS_STORAGE_BUCKET ||= "test-fixture-bucket";
process.env.AWS_ENDPOINT_URL_SQS ||= "http://127.0.0.1:1";
process.env.AWS_ACCESS_KEY_ID ||= "test";
process.env.AWS_SECRET_ACCESS_KEY ||= "test";
process.env.AWS_REGION ||= "us-east-1";
process.env.SCVS_JOB_STATE_CHANGE_QUEUE_URL ||=
  "http://127.0.0.1:1/000000000000/test-queue";
process.env.NODE_ENV = "test";

process.env.SCVS_DRAIN_GRACE_MS ||= "0";
