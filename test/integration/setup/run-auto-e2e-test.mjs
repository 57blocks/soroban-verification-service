import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const autoScope = process.env.SCVS_E2E_AUTO_SCOPE ?? "auto";
if (!["auto", "slow", "all"].includes(autoScope)) {
  throw new Error(`SCVS_E2E_AUTO_SCOPE must be auto, slow, or all; received ${JSON.stringify(autoScope)}.`);
}

const autoEnv = {
  ...process.env,
  ...(autoScope === "slow" ? {} : { SCVS_E2E_ALLOW_BROWSER: "1" }),
};
const jestStatus = run(
  "node",
  ["test/integration/setup/run-e2e-test.mjs", ...process.argv.slice(2)],
  autoEnv
);
if (autoScope === "slow") process.exit(jestStatus);

// The Jest leg above reports through `run-e2e-test.mjs`.
const playwrightArgs = ["--filter", "@scvs/e2e-tests", "exec", "playwright", "test"];
const playwrightEnv = { ...autoEnv };
if (process.env.SCVS_E2E_REPORT_DIR) {
  const reportDir = resolve(repoRoot, process.env.SCVS_E2E_REPORT_DIR);
  mkdirSync(reportDir, { recursive: true });
  const label = (process.env.SCVS_E2E_REPORT_LABEL ?? "e2e").replace(/[^A-Za-z0-9._-]+/g, "-");
  playwrightArgs.push("--reporter=list,json");
  playwrightEnv.PLAYWRIGHT_JSON_OUTPUT_NAME = resolve(reportDir, `${label}-web-playwright.json`);
}
// Runs whatever the Jest leg returned, so both legs' results reach the summary; either failing fails the run.
const playwrightStatus = run("pnpm", playwrightArgs, playwrightEnv);
process.exit(jestStatus !== 0 ? jestStatus : playwrightStatus);
