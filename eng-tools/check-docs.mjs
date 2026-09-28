#!/usr/bin/env node
/** Static: checks every tracked `.md` for budgets, relative links, `Verified by:` targets and invariant refs. No network. */
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, normalize, relative } from "node:path";

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
const trackedSet = new Set(tracked);
const docs = tracked.filter((f) => f.endsWith(".md"));

const findings = [];
const fail = (what) => findings.push(what);

const BUDGETS = {
  "AGENTS.md": 6 * 1024,
  "CLAUDE.md": 256,
  "docs/invariants.md": 18 * 1024,
  "docs/specs/build-environments.md": 8 * 1024,
  "docs/specs/configuration.md": 12 * 1024,
  "docs/specs/data-and-lifecycle.md": 12 * 1024,
  "docs/specs/published-results.md": 12 * 1024,
  "docs/specs/query-and-aggregation.md": 12 * 1024,
  "docs/specs/submission.md": 12 * 1024,
  "docs/specs/verification.md": 12 * 1024,
};
for (const [path, capBytes] of Object.entries(BUDGETS)) {
  if (!trackedSet.has(path)) continue;
  const size = statSync(join(ROOT, path)).size;
  if (size > capBytes) {
    fail(`${path} is ${size}B, over its ${capBytes}B budget`);
  }
}

const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
for (const doc of docs) {
  const text = read(doc);
  for (const [, rawTarget] of text.matchAll(LINK)) {
    const target = rawTarget.trim();
    if (!target || target.startsWith("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [pathPart] = target.split("#");
    if (!pathPart) continue;
    const resolved = normalize(join(dirname(doc), pathPart));
    if (!trackedSet.has(resolved) && !existsSync(join(ROOT, resolved))) {
      fail(`${doc} links to "${target}", which resolves to ${resolved} — not a tracked file`);
    }
  }
}

const VERIFIED_BY_START = /^\*?Verified by:\*?\s*(.*)$/;
for (const doc of docs) {
  const lines = read(doc).split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = VERIFIED_BY_START.exec(lines[i]);
    if (!m) continue;
    let rest = m[1];
    let j = i;
    while (/,\s*$/.test(lines[j]) && j + 1 < lines.length) {
      j += 1;
      rest += ` ${lines[j]}`;
    }
    const refs = [];
    let depth = 0;
    let current = "";
    for (const ch of rest) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        refs.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) refs.push(current);

    for (const rawRef of refs) {
      const ref = rawRef.trim().replace(/\.$/, "");
      if (!ref) continue;
      const backtick = /`([^`]+?)`\s*(\(([^)]*)\))?/.exec(ref);
      if (!backtick) continue;
      const [pathPart, testName] = backtick[1].split("#");
      const trimmedPath = pathPart.trim();
      if (!trimmedPath.includes("/")) continue;
      if (trimmedPath.endsWith("/")) {
        if (!tracked.some((f) => f.startsWith(trimmedPath))) {
          fail(`${doc} has "Verified by: ${ref}" but no tracked file exists under ${trimmedPath}`);
        }
        continue;
      }
      if (!trackedSet.has(trimmedPath)) {
        fail(`${doc} has "Verified by: ${ref}" but ${trimmedPath} is not a tracked file`);
        continue;
      }
      const fileText = read(trimmedPath);
      if (testName && !fileText.includes(testName.trim())) {
        fail(`${doc} has "Verified by: ${ref}" but "${testName.trim()}" does not appear in ${trimmedPath}`);
      }
      if (backtick[3]) {
        for (const substr of backtick[3].split(",")) {
          const needle = substr.trim().replace(/^`|`$/g, "");
          if (needle && !fileText.includes(needle)) {
            fail(`${doc} has "Verified by: ${ref}" but "${needle}" does not appear in ${trimmedPath}`);
          }
        }
      }
    }
  }
}

// Rows are `| # | rule | code location | reason |`, so cells[2] is the code location.
const INVARIANTS = "docs/invariants.md";
if (trackedSet.has(INVARIANTS)) {
  const rows = read(INVARIANTS)
    .split("\n")
    .filter((l) => l.startsWith("|") && l.includes("|", 1))
    .map((l) => l.split("|").map((c) => c.trim()).filter(Boolean));
  for (const cells of rows) {
    const location = cells[2];
    if (!location || /^:?-+:?$/.test(location)) continue;
    if (location === "Code location") continue;
    if (/^-+$/.test(cells[0] ?? "")) continue;
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of location) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current);

    for (const part of parts) {
      const bareOrBacktick = part.replace(/`/g, "").trim();
      const [path] = bareOrBacktick.split(/[#\s(]/);
      if (!path) continue;
      if (!trackedSet.has(path.trim()) && !existsSync(join(ROOT, path.trim()))) {
        fail(`${INVARIANTS} names code location "${part.trim()}", which does not exist`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`✗ ${findings.length} finding(s)\n`);
  for (const f of [...new Set(findings)]) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `✓ ${docs.length} doc(s) checked — budgets, relative links, spec/test bindings, and invariant refs all hold`,
);
