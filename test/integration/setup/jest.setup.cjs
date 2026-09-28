const path = require("node:path");
const fs = require("node:fs");

const dotenv = require("dotenv");

// dotenv never overrides, so this package's .env wins over the repository root's.
for (const candidate of [
  path.join(__dirname, "..", ".env"),
  path.join(__dirname, "..", "..", "..", ".env"),
]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate, quiet: true });
}

process.env.NODE_ENV = "test";

process.env.SCVS_E2E_DRIFT_LOG ||= path.join(
  __dirname,
  "..",
  "..",
  "..",
  "artifacts",
  "e2e-drift.ndjson"
);

try {
  fs.mkdirSync(path.dirname(process.env.SCVS_E2E_DRIFT_LOG), { recursive: true });
  fs.rmSync(process.env.SCVS_E2E_DRIFT_LOG, { force: true });
} catch {
}
