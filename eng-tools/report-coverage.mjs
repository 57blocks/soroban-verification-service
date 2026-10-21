#!/usr/bin/env node
/** Static: merges each workspace package's `coverage/coverage-final.json` into `coverage/` at the root. No network. Exits 0 unconditionally. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const ROOT = process.cwd();
const OUT = join(ROOT, "coverage");

const dirs = execFileSync("git", ["ls-files", "*package.json"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && f !== "package.json")
  .map((f) => f.replace(/\/package\.json$/, ""))
  .sort();

const pct = (metric) => (metric.total === 0 ? "—" : `${metric.pct.toFixed(1)}%`);
const merged = libCoverage.createCoverageMap({});
const rows = [];
const unreadable = [];

for (const dir of dirs) {
  const file = join(ROOT, dir, "coverage", "coverage-final.json");
  if (!existsSync(file)) continue;
  const name = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")).name;
  const own = libCoverage.createCoverageMap({});
  try {
    for (const data of Object.values(JSON.parse(readFileSync(file, "utf8")))) {
      own.addFileCoverage({ ...data, path: relative(ROOT, data.path) });
    }
  } catch (error) {
    unreadable.push(`\`${name}\` (\`${dir}\`): ${error.message}`);
    continue;
  }
  merged.merge(own);
  rows.push({ name, dir, summary: own.getCoverageSummary() });
}

const total = merged.getCoverageSummary();
const lines = [
  "## Test coverage\n",
  rows.length === 0
    ? "No package wrote `coverage/coverage-final.json`.\n"
    : `${pct(total.lines)} of lines and ${pct(total.branches)} of branches across ${rows.length} package(s).\n`,
  "| package | lines | branches | functions | statements |",
  "| :-- | --: | --: | --: | --: |",
  ...rows.map(
    ({ name, dir, summary: s }) =>
      `| \`${name}\` (\`${dir}\`) | ${pct(s.lines)} | ${pct(s.branches)} | ${pct(s.functions)} | ${pct(s.statements)} |`,
  ),
  `| **all** | **${pct(total.lines)}** | **${pct(total.branches)}** | **${pct(total.functions)}** | **${pct(total.statements)}** |`,
  "",
  ...(unreadable.length === 0 ? [] : ["Unreadable, left out:\n", ...unreadable.map((u) => `- ${u}`), ""]),
  "_Reporting only — this step never fails the run._",
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
if (rows.length > 0) {
  const context = libReport.createContext({ dir: OUT, coverageMap: merged, defaultSummarizer: "nested" });
  for (const name of ["html", "lcovonly", "json", "json-summary"]) {
    try {
      reports.create(name).execute(context);
    } catch (error) {
      lines.push("", `The ${name} report failed: ${error.message}`);
    }
  }
}
writeFileSync(join(OUT, "summary.md"), `${lines.join("\n")}\n`);

console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
