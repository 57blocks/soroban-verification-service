/** Test-harness environment only. */
const path = require("node:path");
const fs = require("node:fs");

const dotenv = require("dotenv");

// This package first (deployment coordinates are per-runner), repository root second (shared local values).
for (const candidate of [
  path.join(__dirname, "..", ".env"),
  path.join(__dirname, "..", "..", "..", ".env"),
]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate, quiet: true });
}

process.env.NODE_ENV = "test";

// Where the drift ledger is written. Set to a path under the repo's gitignored artifacts dir by default.
process.env.SCVS_E2E_DRIFT_LOG ||= path.join(
  __dirname,
  "..",
  "..",
  "..",
  "artifacts",
  "e2e-drift.ndjson"
);

// A fresh ledger per run — a stale line from yesterday's run reads as today's finding.
try {
  fs.mkdirSync(path.dirname(process.env.SCVS_E2E_DRIFT_LOG), { recursive: true });
  fs.rmSync(process.env.SCVS_E2E_DRIFT_LOG, { force: true });
} catch {
  // A read-only artifacts dir must not fail the run; conformance.ts degrades to console output.
}
