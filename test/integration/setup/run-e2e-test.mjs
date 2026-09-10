import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const privateUploadTestName = "uses upload_id instead of the chain's source_uri";
const zipUploadTestName = "cli_58_source_tree_zip";
const upgradeLifecycleTestName = "normal upgrade lifecycle";
const timeoutSpecPaths = [
  "cases/sub/sub-09-failure-matrix.spec.ts",
  "cases/sub/sub-10-build-logs.spec.ts",
  "cases/dedup/dedup-06-retryable-failures.spec.ts",
];

function requestedTestPatterns(args) {
  const patterns = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-t" || args[index] === "--testNamePattern") {
      if (args[index + 1]) patterns.push(args[index + 1]);
      index += 1;
    } else if (args[index].startsWith("--testNamePattern=")) {
      patterns.push(args[index].slice("--testNamePattern=".length));
    }
  }
  return patterns;
}

function cli58PrivateUploadWasSelected(args) {
  const patterns = requestedTestPatterns(args);
  const sourceVisibilitySpec = args.some((arg) => arg.includes("cases/src/src-visibility.spec.ts"));
  const publicationSpec = args.some((arg) => arg.includes("cases/pub/pub-status-and-report.spec.ts"));

  if (sourceVisibilitySpec) {
    return patterns.length === 0 || patterns.some(
      (pattern) => pattern.includes(privateUploadTestName) || pattern.includes("cli_58_private_upload")
    );
  }
  return publicationSpec && (
    patterns.length === 0 || patterns.some((pattern) => /E2E-PUB-(07|17)|recipe_source|on_chain_false/.test(pattern))
  );
}

function upgradeLifecycleWasSelected(args) {
  const upgradeSpec = args.some((arg) => arg.includes("cases/upg/upg-normal-lifecycle.spec.ts"));
  return (
    upgradeSpec &&
    requestedTestPatterns(args).some(
      (pattern) => pattern.includes(upgradeLifecycleTestName) || pattern.includes("E2E-UPG-01")
    )
  );
}

function cli58ZipUploadWasSelected(args) {
  const sourceVisibilitySpec = args.some((arg) => arg.includes("cases/src/src-visibility.spec.ts"));
  return sourceVisibilitySpec && requestedTestPatterns(args).some((pattern) => pattern.includes(zipUploadTestName));
}

function timeoutFixtureWasSelected(args) {
  const selectedSpec = args.some((arg) => timeoutSpecPaths.some((path) => arg.includes(path)));
  if (!selectedSpec) return false;
  const patterns = requestedTestPatterns(args);
  return patterns.length === 0 || patterns.some((pattern) => /build_timeout|F-BUILD-TIMEOUT|DEDUP-06\/build_timeout_requeued/.test(pattern));
}

function configuredValue(name) {
  if (process.env[name] !== undefined) return process.env[name];
  for (const path of [resolve(repoRoot, "test/integration/.env"), resolve(repoRoot, ".env")]) {
    if (!existsSync(path)) continue;
    const line = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith(`${name}=`));
    if (!line) continue;
    const value = line.slice(name.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function e2eIsEnabled() {
  const value = configuredValue("SCVS_E2E")?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

/**
 * The job summary is rendered from Jest's own JSON report (`eng-tools/write-e2e-summary.mjs`), so ask for one
 * whenever a report directory is configured.
 */
function withJsonReport(jestArgs) {
  const configured = process.env.SCVS_E2E_REPORT_DIR;
  if (!configured) return jestArgs;
  if (jestArgs.some((arg) => arg === "--json" || arg.startsWith("--json=") || arg.startsWith("--outputFile"))) {
    return jestArgs;
  }
  const reportDir = resolve(repoRoot, configured);
  mkdirSync(reportDir, { recursive: true });
  const label = (process.env.SCVS_E2E_REPORT_LABEL ?? "e2e").replace(/[^A-Za-z0-9._-]+/g, "-");
  // One label can run more than once in a job (the auto suite and a targeted spec, say).
  let report = resolve(reportDir, `${label}-jest.json`);
  for (let index = 2; existsSync(report); index += 1) {
    report = resolve(reportDir, `${label}-${index}-jest.json`);
  }
  return [...jestArgs, "--json", "--outputFile", report];
}

const receivedArgs = process.argv.slice(2);
// pnpm appends a standalone `--` before arguments forwarded to a script.
const args = withJsonReport(receivedArgs.filter((arg) => arg !== "--"));

if (e2eIsEnabled() && cli58PrivateUploadWasSelected(args)) {
  run("bash", [
    "test/fixtures/e2e/run-cli58-private-upload-local.sh",
    ...args,
  ]);
}

if (e2eIsEnabled() && cli58ZipUploadWasSelected(args)) {
  run("bash", ["test/fixtures/e2e/run-cli58-zip-upload-local.sh", ...args]);
}

if (e2eIsEnabled() && upgradeLifecycleWasSelected(args)) {
  run("bash", ["test/fixtures/e2e/run-upgrade-normal-lifecycle.sh", ...args]);
}

if (e2eIsEnabled() && timeoutFixtureWasSelected(args)) {
  run("bash", ["test/fixtures/e2e/run-timeout-fixtures-local.sh", ...args]);
}

run(
  "pnpm",
  ["--filter", "@scvs/e2e-tests", "exec", "jest", "--runInBand", ...args],
  {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-vm-modules`.trim(),
  }
);
