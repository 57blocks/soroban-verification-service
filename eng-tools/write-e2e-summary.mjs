#!/usr/bin/env node
/** Renders this run's own test reports into the GitHub job summary. */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

// GitHub truncates a step summary at 1 MiB and says nothing about it, so keep well clear and drop the per-case
// tables first — the failure and skip sections are the part nobody can reconstruct.
const SUMMARY_BUDGET_BYTES = 900_000;
const MAX_FAILURE_DETAILS = 25;
const MAX_FAILURE_LINES = 40;
const MAX_TABLE_ROWS = 300;
const TABLE_OPEN_ROWS = 30;

function resolveFromRepo(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

const reportDir = resolveFromRepo(
  process.argv[2] ?? process.env.SCVS_E2E_REPORT_DIR ?? "artifacts/e2e-reports"
);
const title = process.env.SCVS_E2E_SUMMARY_TITLE ?? "E2E results";
const configuredLocustSummaryPath = process.env.SCVS_E2E_PERF_LOCUST_SUMMARY_PATH;
const locustSummaryPath = configuredLocustSummaryPath ? resolveFromRepo(configuredLocustSummaryPath) : undefined;
const configuredOpenLocustSummaryPath = process.env.SCVS_E2E_PERF_OPEN_LOCUST_SUMMARY_PATH;
const openLocustSummaryPath = configuredOpenLocustSummaryPath
  ? resolveFromRepo(configuredOpenLocustSummaryPath)
  : undefined;
// Repository-relative when it is inside the checkout, absolute otherwise — a chain of `..` tells the reader
// nothing about where to look.
const reportDirRelative = relative(repoRoot, reportDir);
const reportDirLabel =
  !reportDirRelative || reportDirRelative.startsWith("..") ? reportDir : reportDirRelative;

function stripAnsi(text) {
  // Jest failure messages arrive with the terminal colouring the default reporter applied.
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** Forced-rebuild console tables are intentionally compact enough to compare individual jobs by eye. */
function formatPerfDuration(ms) {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function readPerf01LocustSummary() {
  if (!locustSummaryPath || !existsSync(locustSummaryPath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(locustSummaryPath, "utf8"));
    if (value?.schema_version !== 1 || value.case_id !== "E2E-PERF-01") {
      return { error: "unrecognised PERF-01 Locust summary shape" };
    }
    return value;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function readPerf02LocustSummary() {
  if (!openLocustSummaryPath || !existsSync(openLocustSummaryPath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(openLocustSummaryPath, "utf8"));
    if (value?.schema_version !== 1 || value.case_id !== "E2E-PERF-02") {
      return { error: "unrecognised PERF-02 Locust summary shape" };
    }
    return value;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Case names are free text from spec files, and this repository's read like prose: they carry `|`, `<hash>`,
 * `&`.
 */
/** Inside a backtick code span or a fenced block, where nothing is interpreted. */
function plain(text) {
  return String(text).replace(/\r?\n/g, " ").trim();
}
/** Inside `<summary>` or list prose, where GitHub parses inline HTML — `<hash>` would disappear. */
function html(text) {
  return plain(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Inside a table cell, where an unescaped pipe would also split the row. */
function cell(text) {
  return html(text).replace(/\|/g, "\\|");
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `gate.ts` renames a skipped block to carry its reason. */
function splitSkipReason(name) {
  const match = name.match(/\s*·\s*SKIPPED:\s*(.*?)(?=\s+›|$)/);
  if (!match) return { name, reason: undefined };
  const withoutReason = name.slice(0, match.index) + name.slice(match.index + match[0].length);
  return { name: withoutReason.trim(), reason: match[1].trim() };
}

/**
 * One job renders several reports, and a case can be gate-skipped in one and run in another: the suite that
 * provisions E2E-UPG-01's fixtures is the separate step that then runs it, so `test:auto` reports it skipped.
 *
 * `startsWith` and not equality, because the two names are not the same string. A `caseBlock` skip carries its
 * reason on the *describe*, so Jest's full name reads `<label> · SKIPPED: <reason> <test title>` and what
 * survives `splitSkipReason` is the bare `<label>` — exactly the prefix the executed entry's `<label> <title>`
 * opens with. A `rowTest` skip instead ends with its reason, keeps its row in the stripped name, and so
 * matches no sibling row that ran.
 */
function ranInAnotherReport(entry, executedNames) {
  const { name } = splitSkipReason(entry.name);
  return executedNames.some((executed) => executed.startsWith(name));
}

function jestCases(report) {
  return (report.testResults ?? []).flatMap((suite) =>
    (suite.assertionResults ?? []).map((assertion) => ({
      name:
        assertion.fullName ||
        [...(assertion.ancestorTitles ?? []), assertion.title ?? "(unnamed)"].join(" › "),
      // Jest reports a skip as pending, todo or disabled depending on how it was written; for a summary they
      // are one outcome — the case did not run.
      status:
        assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "skipped",
      ms: assertion.duration ?? 0,
      error: (assertion.failureMessages ?? []).join("\n\n"),
      flaky: false,
    }))
  );
}

function playwrightCases(suites, parents = []) {
  return (suites ?? []).flatMap((suite) => {
    const path = suite.title ? [...parents, suite.title] : parents;
    const own = (suite.specs ?? []).flatMap((spec) =>
      (spec.tests ?? []).map((test) => {
        const results = test.results ?? [];
        return {
          name: [...path, spec.title ?? "(unnamed)"].join(" › "),
          // Playwright reports the outcome against the test's own expectation: `expected` covers a passing test
          // and a legitimately failing `test.fail()`, `flaky` passed on a retry.
          status:
            test.status === "expected" || test.status === "flaky"
              ? "passed"
              : test.status === "skipped"
                ? "skipped"
                : "failed",
          flaky: test.status === "flaky",
          ms: results.reduce((total, result) => total + (result.duration ?? 0), 0),
          error: results
            .map((result) => result.error?.message ?? result.error?.value ?? "")
            .filter(Boolean)
            .join("\n\n"),
        };
      })
    );
    return [...own, ...playwrightCases(suite.suites, path)];
  });
}

/** `smoke-web-playwright.json` → `smoke web (playwright)`. */
function reportLabel(fileName) {
  const base = fileName.replace(/\.json$/, "");
  const match = base.match(/^(.*)-(jest|playwright)$/);
  const label = (match?.[1] ?? base).replace(/[-_]+/g, " ").trim();
  return match ? `${label} (${match[2]})` : label;
}

function readReports() {
  if (!existsSync(reportDir)) return [];
  return readdirSync(reportDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const label = reportLabel(name);
      let data;
      try {
        data = JSON.parse(readFileSync(join(reportDir, name), "utf8"));
      } catch (error) {
        return { label, cases: [], unreadable: error.message };
      }
      if (Array.isArray(data.testResults)) return { label, cases: jestCases(data) };
      if (Array.isArray(data.suites)) return { label, cases: playwrightCases(data.suites) };
      return { label, cases: [], unreadable: "unrecognised report shape" };
    });
}

function count(cases, status) {
  return cases.filter((entry) => entry.status === status).length;
}

const reports = readReports();
const allCases = reports.flatMap((report) => report.cases);
const failed = reports.flatMap((report) =>
  report.cases.filter((entry) => entry.status === "failed").map((entry) => ({ ...entry, report: report.label }))
);
const everySkip = reports.flatMap((report) =>
  report.cases.filter((entry) => entry.status === "skipped").map((entry) => ({ ...entry, report: report.label }))
);
const executed = allCases.filter((entry) => entry.status !== "skipped").map((entry) => entry.name);
const skipped = everySkip.filter((entry) => !ranInAnotherReport(entry, executed));
const superseded = everySkip.length - skipped.length;

function overview() {
  const lines = [`## ${title}`, ""];
  if (reports.length === 0) {
    lines.push(
      "**No test report was produced.** The run stopped before the suite steps, or every case was",
      "filtered out before a report could be written.",
      "",
      `Expected \`<label>-jest.json\` or \`<label>-playwright.json\` under \`${reportDirLabel}\`.`
    );
    return lines;
  }

  lines.push("| suite | ✅ passed | ❌ failed | ⏭️ skipped | time |", "| --- | --: | --: | --: | --: |");
  for (const report of reports) {
    if (report.unreadable) {
      lines.push(`| ${cell(report.label)} | — | — | — | unreadable: ${cell(report.unreadable)} |`);
      continue;
    }
    const ms = report.cases.reduce((total, entry) => total + entry.ms, 0);
    lines.push(
      `| ${cell(report.label)} | ${count(report.cases, "passed")} | ${count(report.cases, "failed")} | ` +
        `${count(report.cases, "skipped")} | ${formatDuration(ms)} |`
    );
  }
  if (reports.length > 1) {
    const ms = allCases.reduce((total, entry) => total + entry.ms, 0);
    lines.push(
      `| **total** | **${count(allCases, "passed")}** | **${count(allCases, "failed")}** | ` +
        `**${skipped.length}** | **${formatDuration(ms)}** |`
    );
    if (superseded > 0) {
      lines.push(
        "",
        `The rows above and the total differ by ${plural(superseded, "skip")}: that many cases are skipped in ` +
          "one report and run in another, and a case this run executed is not one it skipped."
      );
    }
  }
  const flaky = allCases.filter((entry) => entry.flaky).length;
  if (flaky > 0) {
    lines.push("", `${plural(flaky, "case")} passed only on a retry and ${flaky === 1 ? "is" : "are"} counted as passed.`);
  }
  return lines;
}

function perfSection() {
  const openLocust = readPerf02LocustSummary();
  if (openLocust) {
    if (openLocust.error) {
      return ["", "### E2E-PERF-02 Locust Measurement", "", `Measurement unreadable: ${cell(openLocust.error)}`];
    }
    const started = Number(openLocust.started_rebuilds);
    const rate = (count) => `${count} (${started > 0 ? ((count / started) * 100).toFixed(1) : "0.0"}%)`;
    return [
      "",
      "### [E2E-PERF-02] Fixed-Interval Verification Bursts",
      "",
      "```text",
      `Configured duration          : ${openLocust.SCVS_E2E_PERF_OPEN_DURATION_SECONDS} s`,
      `Burst size                    : ${openLocust.SCVS_E2E_PERF_OPEN_BURST_SIZE}`,
      `Burst interval                : ${openLocust.SCVS_E2E_PERF_OPEN_BURST_INTERVAL_SECONDS} s`,
      `Maximum in-flight flows       : ${openLocust.configured_max_in_flight}`,
      `Global rebuild cap            : ${openLocust.configured_max_rebuilds}`,
      `Elapsed                       : ${formatPerfDuration(openLocust.elapsed_ms)}`,
      `Scheduled bursts / flows      : ${openLocust.scheduled_bursts} / ${openLocust.scheduled_arrivals}`,
      `Started / capacity / budget drops : ${started} / ${openLocust.capacity_drops} / ${openLocust.budget_clipped_arrivals}`,
      `Peak in-flight                : ${openLocust.peak_in_flight}`,
      `Verified / failed             : ${rate(openLocust.verified_count)} / ${rate(openLocust.failed_count)}`,
      `Unfinished at shutdown        : ${openLocust.unfinished_at_shutdown}`,
      "```",
      "",
      "Locust endpoint percentiles, capacity drops and per-flow job records are attached as workflow artifacts.",
    ];
  }

  const locust = readPerf01LocustSummary();
  if (locust) {
    if (locust.error) {
      return ["", "### E2E-PERF-01 Locust Measurement", "", `Measurement unreadable: ${cell(locust.error)}`];
    }
    const attempted = Number(locust.started_rebuilds);
    const rate = (count) => `${count} (${attempted > 0 ? ((count / attempted) * 100).toFixed(1) : "0.0"}%)`;
    return [
      "",
      "### [E2E-PERF-01] Locust Closed-Loop Verification Load",
      "",
      "```text",
      `Configured users             : ${locust.configured_users}`,
      `Configured duration          : ${locust.configured_duration_seconds} s`,
      `Configured think time        : ${locust.configured_think_time_seconds} s`,
      `Global rebuild cap            : ${locust.configured_max_rebuilds}`,
      `Elapsed                       : ${formatPerfDuration(locust.elapsed_ms)}`,
      `Started rebuilds              : ${attempted}`,
      `Completed iterations          : ${locust.iterations}`,
      `Verified / failed             : ${rate(locust.verified_count)} / ${rate(locust.failed_count)}`,
      "```",
      "",
      "Locust endpoint percentiles and per-iteration records are attached as workflow artifacts.",
    ];
  }

  return [];
}

function failureSection() {
  if (failed.length === 0) return [];
  const lines = ["", `### ❌ Failed (${failed.length})`, ""];
  for (const [index, entry] of failed.entries()) {
    if (index >= MAX_FAILURE_DETAILS) {
      lines.push(`- ${html(entry.name)} — \`${plain(entry.report)}\``);
      continue;
    }
    const message = stripAnsi(entry.error || "(the report carried no error message)")
      .split(/\r?\n/)
      .slice(0, MAX_FAILURE_LINES)
      .join("\n");
    lines.push(
      `<details><summary><code>${html(entry.report)}</code> — ${html(entry.name)}</summary>`,
      "",
      "```",
      // A failure message can legitimately contain a fence; the outer block must still close.
      message.replace(/```/g, "'''"),
      "```",
      "",
      "</details>",
      ""
    );
  }
  if (failed.length > MAX_FAILURE_DETAILS) {
    lines.push("", `Messages for the first ${MAX_FAILURE_DETAILS} failures only; the rest are listed above by name.`);
  }
  return lines;
}

function skipSection() {
  if (skipped.length === 0) return [];
  const byReason = new Map();
  for (const entry of skipped) {
    const { name, reason } = splitSkipReason(entry.name);
    const key = reason ?? "no reason recorded in the test name";
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key).push(name);
  }
  const lines = [
    "",
    `### ⏭️ Skipped (${skipped.length})`,
    "",
    "Grouped by the prerequisite the run did not satisfy, which is what makes a skip actionable.",
    "",
  ];
  for (const [reason, names] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(
      `<details><summary><strong>${html(reason)}</strong> — ${plural(names.length, "case")}</summary>`,
      ""
    );
    for (const name of names) lines.push(`- ${html(name)}`);
    lines.push("", "</details>", "");
  }
  return lines;
}

const STATUS_MARK = { passed: "✅", failed: "❌", skipped: "⏭️" };

function caseTables() {
  const lines = [];
  for (const report of reports) {
    if (report.cases.length === 0) continue;
    const rows = report.cases.slice(0, MAX_TABLE_ROWS);
    const open = report.cases.length <= TABLE_OPEN_ROWS ? " open" : "";
    lines.push(
      "",
      `<details${open}><summary><code>${html(report.label)}</code> — ${plural(report.cases.length, "case")}</summary>`,
      "",
      "| case | status | time |",
      "| --- | --- | --: |"
    );
    for (const entry of rows) {
      const { name } = splitSkipReason(entry.name);
      const mark = `${STATUS_MARK[entry.status]}${entry.flaky ? " flaky" : ""}`;
      lines.push(`| ${cell(name)} | ${mark} | ${formatDuration(entry.ms)} |`);
    }
    if (report.cases.length > rows.length) {
      lines.push(`| _… ${report.cases.length - rows.length} more_ | | |`);
    }
    lines.push("", "</details>", "");
  }
  if (lines.length === 0) return [];
  return ["", "### Cases", ...lines];
}

const head = [...overview(), ...perfSection(), ...failureSection(), ...skipSection()];
let body = [...head, ...caseTables()].join("\n");
if (Buffer.byteLength(body, "utf8") > SUMMARY_BUDGET_BYTES) {
  body = [
    ...head,
    "",
    "The per-case tables were dropped to stay inside GitHub's summary limit — the full reports are in",
    "the run's uploaded artifacts.",
  ].join("\n");
}
body = `${body}\n`;

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  appendFileSync(summaryPath, body);
  console.log(
    `wrote ${reports.length} report(s) to the job summary: ` +
      `${count(allCases, "passed")} passed, ${count(allCases, "failed")} failed, ${skipped.length} skipped`
  );
} else {
  process.stdout.write(body);
}
