#!/usr/bin/env node
/** Reads the npm advisory database, no AWS. Fails when a critical, high or moderate advisory reaches a shipped unit, or when the database cannot be read. */
import { collectAdvisories } from "./advisories.mjs";

// Moderate too: a denial of service that takes a public API down is often rated no higher (GHSA-27r3-jxmh-p828 was).
const GATED = new Set(["critical", "high", "moderate"]);

const result = collectAdvisories();
if (result.unavailable) {
  console.error(`check:advisories cannot tell whether a shipped unit is affected — ${result.unavailable}`);
  process.exit(1);
}

const blocking = result.reaching.filter((row) => GATED.has(row.severity));
if (blocking.length === 0) {
  console.log(`check:advisories: no critical, high or moderate advisory reaches a shipped unit (${result.rows.length} advisories in all).`);
  process.exit(0);
}

console.error("check:advisories: these reach a shipped unit through a `dependencies` edge:");
for (const row of blocking) {
  console.error(`  ${row.severity} ${row.module} ${row.installed} (patched ${row.patched}) via ${row.path} — ${row.id}`);
}
console.error("Raise the dependency, or add a `pnpm.overrides` entry in package.json, then regenerate the lockfile.");
process.exit(1);
