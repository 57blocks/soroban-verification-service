#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logPath =
  process.env.SCVS_E2E_DRIFT_LOG ?? join(here, "..", "..", "..", "artifacts", "e2e-drift.ndjson");

if (!existsSync(logPath)) {
  console.log(`No drift ledger at ${logPath}. Either nothing diverged, or no run has happened.`);
  process.exit(0);
}

const entries = readFileSync(logPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const byGap = new Map();
for (const entry of entries) {
  byGap.set(entry.gap, [...(byGap.get(entry.gap) ?? []), entry]);
}

console.log(`${entries.length} observation(s) across ${byGap.size} gap(s)\n`);
for (const [gap, list] of [...byGap.entries()].sort()) {
  console.log(`${gap}  (${list.length})`);
  console.log(`  required: ${list[0].required}`);
  console.log(`  observed: ${list[0].observed}`);
  for (const entry of list) console.log(`    · ${entry.case}: ${entry.detail}`);
  console.log("");
}
