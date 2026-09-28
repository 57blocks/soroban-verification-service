#!/usr/bin/env node
/** Static: the compose-built fixtures' `(cliver, rsver)` pairs agree across the build script, deploy script and registry. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const BUILD_SCRIPT = "test/fixtures/e2e/build-purpose-contracts.sh";
const DEPLOY_SCRIPT = "test/fixtures/e2e/deploy-testnet.sh";
const REGISTRY = "test/fixtures/e2e/registry.yaml";

const read = (path) => readFileSync(join(ROOT, path), "utf8");

function buildTargets() {
  const text = read(BUILD_SCRIPT);
  const open = text.indexOf("compose_targets=(");
  if (open === -1) throw new Error(`${BUILD_SCRIPT}: no compose_targets=( … ) array found`);
  const close = text.indexOf("\n)", open);
  if (close === -1) throw new Error(`${BUILD_SCRIPT}: compose_targets=( … ) is not closed`);

  const rows = [];
  for (const line of text.slice(open, close).split("\n")) {
    const quoted = /^\s*"([^"]+)"\s*$/.exec(line);
    if (!quoted) continue;
    const [id, cliver, rsver, output, bldopt] = quoted[1].split("|");
    if (!id || !cliver || !rsver || !output || !bldopt) {
      throw new Error(
        `${BUILD_SCRIPT}: malformed compose_targets row ${JSON.stringify(quoted[1])} — expected ` +
          `id|cliver|rsver|output|build options`,
      );
    }
    rows.push({ id, cliver, rsver, output, bldopt: bldopt.trim().split(/\s+/) });
  }
  if (rows.length === 0) throw new Error(`${BUILD_SCRIPT}: compose_targets is empty`);
  return rows;
}

function deployTargets() {
  const text = read(DEPLOY_SCRIPT);
  const at = text.indexOf('if [[ "$deploy_set" == "compose-only" ]]');
  if (at === -1) throw new Error(`${DEPLOY_SCRIPT}: no compose-only branch found`);

  const rows = [];
  for (const match of text.slice(at).matchAll(/"([A-Z0-9-]+)\|([a-z0-9.-]+\.wasm)"/g)) {
    rows.push({ id: match[1], output: match[2] });
  }
  if (rows.length === 0) throw new Error(`${DEPLOY_SCRIPT}: compose-only branch lists no fixtures`);
  return rows;
}

function registryContracts() {
  const lines = read(REGISTRY).split("\n");
  const start = lines.findIndex((line) => line === "contracts:");
  if (start === -1) throw new Error(`${REGISTRY}: no top-level contracts: key`);

  const entries = new Map();
  let current;
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z_]+:/.test(line)) break;
    const key = /^ {2}([a-z0-9_]+):\s*$/.exec(line);
    if (key) {
      current = { name: key[1], roles: [], cliver: undefined, rsver: undefined, bldopt: undefined };
      entries.set(key[1], current);
      continue;
    }
    if (!current) continue;
    const roles = /^ {4}fixture_roles:\s*\[([^\]]*)\]/.exec(line);
    if (roles) current.roles = roles[1].split(",").map((r) => r.trim()).filter(Boolean);
    const cliver = /^ {4}cliver:\s*(.+?)\s*$/.exec(line);
    if (cliver) current.cliver = cliver[1];
    const rsver = /^ {4}rsver:\s*(.+?)\s*$/.exec(line);
    if (rsver) current.rsver = rsver[1];
    const bldopt = /^ {4}bldopt:\s*\[(.*)\]\s*$/.exec(line);
    if (bldopt) current.bldopt = bldopt[1].split(",").map((o) => o.trim()).filter(Boolean);
  }
  return entries;
}

const problems = [];
const build = buildTargets();
const deploy = deployTargets();
const registry = registryContracts();

console.log(`compose targets in ${BUILD_SCRIPT}: ${build.length}`);

for (const row of build) {
  const match = deploy.find((d) => d.id === row.id);
  if (!match) {
    problems.push(`${row.id} is in ${BUILD_SCRIPT} but not in ${DEPLOY_SCRIPT}'s compose-only branch — it would be built and never deployed`);
    continue;
  }
  if (match.output !== row.output) {
    problems.push(`${row.id} builds ${row.output} but ${DEPLOY_SCRIPT} deploys ${match.output}`);
  }
}
for (const row of deploy) {
  if (!build.some((b) => b.id === row.id)) {
    problems.push(`${row.id} is in ${DEPLOY_SCRIPT} but not in ${BUILD_SCRIPT}'s compose_targets — nothing can produce it`);
  }
}

for (const row of build) {
  const entry = [...registry.values()].find((c) => c.roles.includes(row.id));
  if (!entry) {
    problems.push(`${row.id} has no contracts: entry in ${REGISTRY} whose fixture_roles include it — the pair is unreviewed`);
    continue;
  }
  if (entry.cliver !== row.cliver) {
    problems.push(`${row.id}: ${BUILD_SCRIPT} builds cliver ${row.cliver}, ${REGISTRY} (${entry.name}) records ${entry.cliver}`);
  }
  if (entry.rsver !== row.rsver) {
    problems.push(`${row.id}: ${BUILD_SCRIPT} builds rsver ${row.rsver}, ${REGISTRY} (${entry.name}) records ${entry.rsver}`);
  }

  if (!entry.bldopt) {
    problems.push(
      `${row.id}: ${REGISTRY} (${entry.name}) records no flow-style \`bldopt: [...]\` — the build options ` +
        `are part of the recipe and have to be reviewable alongside the pair`,
    );
  } else if (entry.bldopt.join(" ") !== row.bldopt.join(" ")) {
    problems.push(
      `${row.id}: ${BUILD_SCRIPT} builds with [${row.bldopt.join(" ")}], ${REGISTRY} (${entry.name}) ` +
        `records [${entry.bldopt.join(" ")}]`,
    );
  }
}

const outputs = new Map();
for (const row of build) {
  const clash = outputs.get(row.output);
  if (clash) problems.push(`${row.id} and ${clash} both write ${row.output}`);
  outputs.set(row.output, row.id);
}

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} disagreement(s) between the fixture tables:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nThese three files describe the same fixtures and none of them can see the others. Fix the one\n" +
      "that is wrong — for a pair, the registry entry is the reviewed record and the shell table is what\n" +
      "actually runs, so a disagreement means a fixture is being built on a pair nobody signed off on.",
  );
  process.exit(1);
}

for (const row of build) {
  const entry = [...registry.values()].find((c) => c.roles.includes(row.id));
  console.log(`  ✓ ${row.id.padEnd(16)} ${row.cliver.split("#")[0]} / ${row.rsver.padEnd(7)} → ${row.output.padEnd(22)} (${entry.name})`);
  console.log(`      bldopt: ${row.bldopt.join(" ")}`);
}
console.log("\n✓ build table, deploy list and registry.yaml agree on every compose-built fixture.");
