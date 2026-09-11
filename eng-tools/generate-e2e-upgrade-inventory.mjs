#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function fromRepo(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

const outputRoot = fromRepo(process.env.SCVS_FIXTURE_OUTPUT_ROOT ?? "artifacts/e2e-fixtures");
const basePath = fromRepo(
  process.env.SCVS_E2E_BASE_FIXTURES ?? "test/integration/fixtures/e2e-fixtures.dev.json"
);
const deploymentsPath = fromRepo(
  process.env.SCVS_FIXTURE_DEPLOYMENTS ?? `${outputRoot}/testnet-deployments.ndjson`
);
const buildManifestPath = fromRepo(
  process.env.SCVS_E2E_BUILD_MANIFEST ?? `${outputRoot}/purpose-built-wasm.ndjson`
);
const outputPath = fromRepo(
  process.argv[2] ?? process.env.SCVS_E2E_FIXTURES ?? `${outputRoot}/e2e-upgrade-fixtures.json`
);
const expectedScope = process.env.SCVS_FIXTURE_DEPLOYMENT_SCOPE;

function records(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSON record ${path}:${index + 1}: ${error.message}`);
      }
    });
}

function one(records, fixtureId, scoped = false) {
  const matches = records.filter(
    (record) =>
      record.fixture_id === fixtureId &&
      (!scoped || !expectedScope || (record.deployment_scope ?? "stable") === expectedScope)
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one ${fixtureId}${scoped && expectedScope ? ` for ${expectedScope}` : ""}, found ${matches.length}`
    );
  }
  return matches[0];
}

const inventory = JSON.parse(readFileSync(basePath, "utf8"));
const deployment = one(records(deploymentsPath), "F-UPG-testnet", true);
const oldBuild = one(records(buildManifestPath), "F-UPG-v1");
const newBuild = one(records(buildManifestPath), "F-UPG-v2");

for (const build of [oldBuild, newBuild]) {
  if (!build.source_archive || !build.source_sha256 || !build.wasm_hash) {
    throw new Error(`${build.fixture_id} build record is missing source or Wasm evidence`);
  }
}
if (deployment.wasm_hash !== oldBuild.wasm_hash) {
  throw new Error("F-UPG deployment does not start at the F-UPG-v1 Wasm hash");
}
if (deployment.prepared_new_wasm_hash !== newBuild.wasm_hash) {
  throw new Error("F-UPG deployment does not name the F-UPG-v2 Wasm hash");
}

function versionFixture(id, build, wasmHash, counterpartHash) {
  return {
    id,
    note: `Run-scoped normal-upgrade fixture from ${build.fixture_id}; do not reuse outside this run.`,
    network: deployment.network,
    contract_id: deployment.contract_id,
    wasm_hash: wasmHash,
    prepared_new_wasm_hash: counterpartHash,
    source_path: build.source_archive,
    source_sha256: build.source_sha256,
    run_scoped_recipe: true,
    bldarg: ["contract", "build"],
    bldopt: [
      "--locked",
      "--manifest-path=contracts/verified-demo/Cargo.toml",
      "--package=verified-demo",
      "--optimize",
    ],
  };
}

inventory.contracts ??= {};
inventory.contracts["F-UPG-V1"] = versionFixture(
  "F-UPG-V1",
  oldBuild,
  oldBuild.wasm_hash,
  newBuild.wasm_hash
);
inventory.contracts["F-UPG-V2"] = versionFixture(
  "F-UPG-V2",
  newBuild,
  newBuild.wasm_hash,
  oldBuild.wasm_hash
);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`generated upgrade E2E fixture inventory: ${outputPath}`);
