import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { smokeBrowserCases, smokeJestCases } from "./smoke-cases.ts";

const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(integrationRoot, "..", "..");

for (const path of [join(integrationRoot, ".env"), join(repoRoot, ".env")]) {
  dotenv.config({ path, quiet: true });
}

function quotedCasePattern(ids: readonly string[]): string {
  return ids
    .map((id) => `${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s+—|$)`)
    .join("|");
}

function run(command: string, args: string[], environment: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd: integrationRoot, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runJson(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  reportPath: string
): unknown {
  const result = spawnSync(command, args, {
    cwd: integrationRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  return JSON.parse(readFileSync(reportPath, "utf8"));
}

function assertJestCasesExecuted(
  reportPath: string,
  selectedCases = smokeJestCases
): void {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    testResults: Array<{ assertionResults: Array<{ fullName: string; status: string }> }>;
  };
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
  const missing = selectedCases
    .map(({ id }) => id)
    .filter(
      (id) =>
        !assertions.some(
          (assertion) => assertion.fullName.includes(id) && assertion.status !== "pending" && assertion.status !== "todo"
        )
    );
  if (missing.length > 0) {
    throw new Error(`Smoke manifest cases were not executed: ${missing.join(", ")}.`);
  }
}

function e2eIsEnabled(): boolean {
  const value = process.env.SCVS_E2E?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function announce(stage: string, ids: readonly string[]): void {
  process.stdout.write(`\n[smoke] ${stage}: ${ids.join(", ")}\n`);
}

function hasPreparedFixture(fixtureId: string | undefined): boolean {
  if (!fixtureId || !process.env.SCVS_E2E_FIXTURES) return false;
  const inventoryPath = isAbsolute(process.env.SCVS_E2E_FIXTURES)
    ? process.env.SCVS_E2E_FIXTURES
    : resolve(integrationRoot, process.env.SCVS_E2E_FIXTURES);
  if (!existsSync(inventoryPath)) return false;

  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
    contracts?: Record<string, { contract_id?: string; wasm_hash?: string; source_path?: string; source_sha256?: string }>;
  };
  const fixture = inventory.contracts?.[fixtureId];
  if (!fixture?.contract_id || !fixture.wasm_hash || !fixture.source_path || !fixture.source_sha256) {
    return false;
  }
  const archivePath = isAbsolute(fixture.source_path)
    ? fixture.source_path
    : resolve(repoRoot, fixture.source_path);
  return existsSync(archivePath);
}

interface PlaywrightSuite {
  readonly title: string;
  readonly suites?: readonly PlaywrightSuite[];
  readonly specs?: readonly { readonly title: string; readonly tests: readonly { readonly status: string }[] }[];
}

function collectPlaywrightTests(
  suites: readonly PlaywrightSuite[],
  parents: string[] = []
): Array<{ fullName: string; status: string }> {
  return suites.flatMap((suite) => {
    const path = [...parents, suite.title];
    const current = (suite.specs ?? []).flatMap((spec) =>
      spec.tests.map(({ status }) => ({ fullName: [...path, spec.title].join(" "), status }))
    );
    return [...current, ...collectPlaywrightTests(suite.suites ?? [], path)];
  });
}

function assertBrowserCasesExecuted(report: unknown): void {
  const suites = (report as { suites: readonly PlaywrightSuite[] }).suites;
  const tests = collectPlaywrightTests(suites);
  const missing = smokeBrowserCases
    .map(({ id }) => id)
    .filter(
      (id) => !tests.some((test) => test.fullName.includes(id) && test.status !== "skipped")
    );
  if (missing.length > 0) {
    throw new Error(`Smoke manifest browser cases were not executed: ${missing.join(", ")}.`);
  }
}

const smokeEnv = {
  ...process.env,
  SCVS_E2E_SMOKE: "1",
  SCVS_E2E_ALLOW_BROWSER: "1",
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-vm-modules`.trim(),
};
// `eng-tools/write-e2e-summary.mjs` renders the job summary from these two reports, which until now were
// written into a temp directory and deleted on the way out.
const configuredReportDir = process.env.SCVS_E2E_REPORT_DIR;
const persistentReportDir = configuredReportDir
  ? isAbsolute(configuredReportDir)
    ? configuredReportDir
    : resolve(repoRoot, configuredReportDir)
  : undefined;
const reportLabel = process.env.SCVS_E2E_REPORT_LABEL ?? "smoke";
if (persistentReportDir) mkdirSync(persistentReportDir, { recursive: true });
const reportDir = persistentReportDir ?? mkdtempSync(join(tmpdir(), "scvs-smoke-"));
const reportPath = join(reportDir, persistentReportDir ? `${reportLabel}-api-jest.json` : "jest.json");
const browserReportPath = join(
  reportDir,
  persistentReportDir ? `${reportLabel}-web-playwright.json` : "playwright.json"
);
const directlyRunJestCases = smokeJestCases.filter(
  ({ provisioned, fixtureId }) => !provisioned || hasPreparedFixture(fixtureId)
);
const provisionedJestCases = smokeJestCases.filter(
  ({ provisioned, fixtureId }) => provisioned && !hasPreparedFixture(fixtureId)
);

try {
  announce("1/3 Web", smokeBrowserCases.map(({ id }) => id));
  const browserReport = runJson(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      ...smokeBrowserCases.map(({ file }) => file),
      "--grep",
      quotedCasePattern(smokeBrowserCases.map(({ id }) => id)),
      "--reporter=json",
    ],
    { ...smokeEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: browserReportPath },
    browserReportPath
  );
  if (e2eIsEnabled()) assertBrowserCasesExecuted(browserReport);

  announce("2/3 API and verification", directlyRunJestCases.map(({ id }) => id));
  run(
    "pnpm",
    [
      "exec",
      "jest",
      "--runInBand",
      ...new Set(directlyRunJestCases.map(({ file }) => file)),
      "--testNamePattern",
      quotedCasePattern(directlyRunJestCases.map(({ id }) => id)),
      "--json",
      "--outputFile",
      reportPath,
    ],
    smokeEnv
  );
  if (e2eIsEnabled()) assertJestCasesExecuted(reportPath, directlyRunJestCases);
  for (const smokeCase of provisionedJestCases) {
    if (!e2eIsEnabled()) continue;
    announce("3/3 Provisioned verification", [smokeCase.id]);
    // That script forwards trailing arguments to its own Jest run, so the provisioned leg can report into the
    // same directory instead of being the one case the summary cannot see.
    const provisionedReport = persistentReportDir
      ? join(
          persistentReportDir,
          `${reportLabel}-provisioned-${smokeCase.id.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-jest.json`
        )
      : undefined;
    run(
      "bash",
      [
        "test/fixtures/e2e/run-cli58-private-upload-local.sh",
        smokeCase.file,
        "--testNamePattern",
        quotedCasePattern([smokeCase.id]),
        ...(provisionedReport ? ["--json", "--outputFile", provisionedReport] : []),
      ],
      smokeEnv
    );
  }
} finally {
  if (!persistentReportDir) rmSync(reportDir, { recursive: true, force: true });
}
