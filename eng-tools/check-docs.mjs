#!/usr/bin/env node
/**
 * Static: reads every tracked `.md` file. No network, no AWS.
 *
 * Four checks, run over whatever the doc-restructure work has produced so far:
 *   1. byte budgets   — a tracked doc named in BUDGETS must not exceed its cap.
 *   2. relative links  — every `[text](path)` pointing at a repo-relative, non-anchor,
 *      non-URL target must resolve to a tracked file.
 *   3. spec -> test    — a `Verified by:` line must name a path that exists, and if it
 *      names `file#test-name`, the test name must appear in that file.
 *   4. invariant refs  — invariants.md's rule rows must name a code location that exists.
 *
 * Checks 1, 3 and 4 are no-ops until their target files exist (docs/invariants.md, the
 * spec docs under docs/specs/) — they activate themselves as the restructure lands.
 *
 * A fifth check (prose paths — a backtick-quoted string outside markdown link syntax that
 * looks like a doc path) was tried and dropped: distinguishing a real document reference
 * from a directory-convention mention (`src/`, `dist/`, `components/`) or a citation inside
 * a document's own already-linked path needs semantic judgment a regex can't reliably make,
 * and the false-positive rate made it unusable as a gate. A prose reference to a document
 * exported out of this repository is a one-time cleanup, not a standing invariant to enforce.
 */
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

// ── 1. byte budgets ──────────────────────────────────────────────────────────────────────────────
// Caps apply to files once they exist. A file not yet created is not a finding — it is the
// restructure's remaining work, tracked in the plan, not in this gate.
const BUDGETS = {
  "AGENTS.md": 6 * 1024,
  "CLAUDE.md": 256,
  "docs/invariants.md": 14 * 1024,
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

// ── 2. relative link validity ───────────────────────────────────────────────────────────────────
// `[text](target)` — skip bare anchors (#foo), absolute URLs (scheme:), and mailto:.
const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
for (const doc of docs) {
  const text = read(doc);
  for (const [, rawTarget] of text.matchAll(LINK)) {
    const target = rawTarget.trim();
    if (!target || target.startsWith("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // has a scheme (http:, mailto:, etc.)
    const [pathPart] = target.split("#");
    if (!pathPart) continue; // pure in-document anchor
    const resolved = normalize(join(dirname(doc), pathPart));
    if (!trackedSet.has(resolved) && !existsSync(join(ROOT, resolved))) {
      fail(`${doc} links to "${target}", which resolves to ${resolved} — not a tracked file`);
    }
  }
}

// ── 3. spec -> test binding ─────────────────────────────────────────────────────────────────────
// A spec claim's `Verified by:` (plain or `*Verified by:*`) introduces a comma-separated list of
// backtick-quoted references, each either a bare `path`, a `path#testName`, or a `path` followed by
// a parenthesised, comma-separated list of substrings (symbol names, test-case IDs) that must all
// appear literally in that file. The list may wrap across lines — it continues as long as each line
// ends with a comma, stopping at the first line that doesn't (or a blank line / heading).
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
    // Split on top-level commas only — a comma inside `(...)` separates substrings, not references.
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
      // The first backtick pair is the path; a lone trailing backtick belongs to a follow-on
      // possessive ("`advanceJob`'s conditional `UPDATE`") and is not part of this reference.
      const backtick = /`([^`]+?)`\s*(\(([^)]*)\))?/.exec(ref);
      if (!backtick) continue; // prose continuation ("full reasoning there", etc.) — not a reference
      const [pathPart, testName] = backtick[1].split("#");
      const trimmedPath = pathPart.trim();
      if (!trimmedPath.includes("/")) continue; // a bare filename (policy.json) — conceptual, not a path
      // A directory reference (trailing slash, no extension) is satisfied by any tracked file under it.
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

// ── 4. invariant code-location refs ─────────────────────────────────────────────────────────────
// invariants.md rows are `# | rule | code location | reason`. The code location column (index 2,
// after the leading `#` and `rule` columns) may itself hold one or more comma-separated `path` or
// `path#symbol`/`path (symbol)` references; only each path half is checked for existence.
const INVARIANTS = "docs/invariants.md";
if (trackedSet.has(INVARIANTS)) {
  const rows = read(INVARIANTS)
    .split("\n")
    .filter((l) => l.startsWith("|") && l.includes("|", 1))
    .map((l) => l.split("|").map((c) => c.trim()).filter(Boolean));
  for (const cells of rows) {
    const location = cells[2];
    if (!location || /^:?-+:?$/.test(location)) continue; // header separator row
    if (location === "Code location") continue; // header row itself
    if (/^-+$/.test(cells[0] ?? "")) continue; // header separator row, first cell form
    // Split on top-level commas only — a comma inside `(...)` is part of an explanatory aside,
    // not a separator between references (e.g. "`x.ts` (no `@scvs/db`, no `@scvs/aws`)").
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
