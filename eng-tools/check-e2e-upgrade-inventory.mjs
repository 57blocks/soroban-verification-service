#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const fromRepo = (path) => (isAbsolute(path) ? path : resolve(repoRoot, path));
const inventoryPath = fromRepo(process.env.SCVS_E2E_FIXTURES ?? "artifacts/e2e-fixtures/e2e-upgrade-fixtures.json");
const deploymentsPath = fromRepo(process.env.SCVS_FIXTURE_DEPLOYMENTS ?? "artifacts/e2e-fixtures/testnet-deployments.ndjson");
const expectedScope = process.env.SCVS_FIXTURE_DEPLOYMENT_SCOPE;
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const deployments = readFileSync(deploymentsPath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
const errors = [];
const fixture = (id) => inventory.contracts?.[id];
const old = fixture("F-UPG-V1");
const newer = fixture("F-UPG-V2");
const deployment = deployments.filter(
  (entry) =>
    entry.fixture_id === "F-UPG-testnet" &&
    (!expectedScope || (entry.deployment_scope ?? "stable") === expectedScope)
);

function check(condition, message) {
  if (!condition) errors.push(message);
}

function sourceCheck(entry, id) {
  check(entry, `inventory is missing ${id}`);
  if (!entry) return;
  const sourcePath = fromRepo(entry.source_path ?? "");
  check(existsSync(sourcePath), `${id} source archive does not exist: ${sourcePath}`);
  if (existsSync(sourcePath)) {
    const hash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    check(hash === entry.source_sha256, `${id} source archive hash does not match inventory`);
  }
}

sourceCheck(old, "F-UPG-V1");
sourceCheck(newer, "F-UPG-V2");
check(deployment.length === 1, `expected one F-UPG-testnet deployment, found ${deployment.length}`);
check(old?.contract_id === newer?.contract_id, "v1 and v2 must target the same contract address");
check(old?.wasm_hash !== newer?.wasm_hash, "v1 and v2 Wasm hashes must differ");
check(old?.wasm_hash === deployment[0]?.wasm_hash, "deployment must start at the v1 Wasm hash");
check(newer?.wasm_hash === deployment[0]?.prepared_new_wasm_hash, "deployment must name the v2 Wasm hash");

if (errors.length > 0) {
  console.error(`Upgrade E2E fixture inventory check failed (${errors.length}):`);
  errors.forEach((error) => console.error(`  - ${error}`));
  process.exit(1);
}

console.log(`Upgrade E2E fixture inventory is consistent: ${inventoryPath}`);
