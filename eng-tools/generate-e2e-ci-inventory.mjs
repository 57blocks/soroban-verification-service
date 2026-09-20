#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function resolveFromRepo(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

const basePath = resolveFromRepo(
  process.env.SCVS_E2E_BASE_FIXTURES ?? "test/integration/fixtures/e2e-fixtures.dev.json"
);
const deploymentsPath = resolveFromRepo(
  process.env.SCVS_FIXTURE_DEPLOYMENTS ?? "artifacts/e2e-fixtures/testnet-deployments.ndjson"
);
const outputPath = resolveFromRepo(
  process.argv[2] ??
    process.env.SCVS_E2E_FIXTURES ??
    "artifacts/e2e-fixtures/e2e-fixtures.ci.json"
);
const fixtureOutputRoot = resolveFromRepo(
  process.env.SCVS_FIXTURE_OUTPUT_ROOT ?? "artifacts/e2e-fixtures"
);
const buildManifestPath = resolveFromRepo(
  process.env.SCVS_E2E_BUILD_MANIFEST ?? `${fixtureOutputRoot}/purpose-built-wasm.ndjson`
);
const expectedScope = process.env.SCVS_FIXTURE_DEPLOYMENT_SCOPE;
const performanceTargetCount = process.env.SCVS_FIXTURE_PERF_TARGET_COUNT
  ? Number(process.env.SCVS_FIXTURE_PERF_TARGET_COUNT)
  : undefined;
const fixtureOverlay = process.env.SCVS_E2E_FIXTURE_OVERLAY;
if (fixtureOverlay !== undefined && fixtureOverlay !== "zip" && fixtureOverlay !== "timeout") {
  throw new Error(`SCVS_E2E_FIXTURE_OVERLAY must be "zip" or "timeout" when set, received ${JSON.stringify(fixtureOverlay)}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readDeployments(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid deployment record ${path}:${index + 1}: ${error.message}`);
      }
    });
}

function readBuildManifest(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid build record ${path}:${index + 1}: ${error.message}`);
      }
    });
}

function deployment(records, fixtureId) {
  const matches = records.filter(
    (record) =>
      record.fixture_id === fixtureId &&
      (!expectedScope || record.deployment_scope === expectedScope)
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one ${fixtureId} deployment${expectedScope ? ` for scope ${expectedScope}` : ""}, found ${matches.length}`
    );
  }
  return matches[0];
}

/** For a fixture whose deployment is a scope of its own rather than part of `all`. */
function optionalDeployment(records, fixtureId) {
  const matches = records.filter(
    (record) =>
      record.fixture_id === fixtureId &&
      (!expectedScope || record.deployment_scope === expectedScope)
  );
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new Error(
      `expected at most one ${fixtureId} deployment${expectedScope ? ` for scope ${expectedScope}` : ""}, found ${matches.length}`
    );
  }
  return matches[0];
}

function applyTarget(fixture, record) {
  if (!fixture) throw new Error(`base inventory is missing ${record.fixture_id}`);
  fixture.network = record.network;
  fixture.contract_id = record.contract_id;
  fixture.wasm_hash = record.wasm_hash;
}

function buildRecord(records, fixtureId) {
  const matches = records.filter((record) => record.fixture_id === fixtureId);
  if (matches.length !== 1) {
    throw new Error(`expected one ${fixtureId} build record, found ${matches.length}`);
  }
  return matches[0];
}

const inventory = readJson(basePath);
const records = readDeployments(deploymentsPath);
const buildRecords = fixtureOverlay === "timeout" ? [] : readBuildManifest(buildManifestPath);

// CI creates these archives on the runner. libarchive header bytes vary between releases, so the committed
// template hash is not authoritative for a run-scoped inventory.
function rebindArchiveHash(fixtureId, archivePath) {
  const fixture = inventory.contracts?.[fixtureId];
  if (!fixture) throw new Error(`base inventory is missing ${fixtureId}`);
  const path = resolveFromRepo(archivePath);
  fixture.source_path = archivePath;
  fixture.source_sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
}

// `generate-fixtures.sh` records every archive it packages, with the same repository-relative path the
// inventory names, so its manifest is the authority on what this runner generated.
function generatedArchivePaths() {
  // The fixed corpus location, not `fixtureOutputRoot`: inventory `source_path`s are relative to it, and
  // `check-e2e-fixture-inventory.mjs` reads the same manifest from the same place.
  const manifestPath = resolve(repoRoot, "artifacts/e2e-fixtures/manifest.ndjson");
  if (!existsSync(manifestPath)) return new Set();
  return new Set(
    readFileSync(manifestPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`invalid generated fixture record ${manifestPath}:${index + 1}: ${error.message}`);
        }
      })
      // The declared-hash-mismatch record carries no archive of its own.
      .map((record) => record.path)
      .filter(Boolean)
  );
}

if (process.env.SCVS_FIXTURE_ALLOW_PLATFORM_HASH === "1") {
  const generatedPaths = generatedArchivePaths();
  for (const [fixtureId, fixture] of Object.entries(inventory.contracts ?? {})) {
    if (fixture?.source_path && generatedPaths.has(fixture.source_path)) {
      rebindArchiveHash(fixtureId, fixture.source_path);
    }
  }

  // Packaged by other scripts, so absent from that manifest and just as platform-dependent:
  // `prepare-ci-sources.sh` writes the multi-package archive, and `build-purpose-contracts.sh`'s `upgrade`
  // scope writes F-UPG's v1 source archive.
  for (const [fixtureId, archivePath] of [
    ["F-MULTIPKG", "artifacts/e2e-fixtures/archives/multi-package-source.tar.gz"],
    ["F-UPG", "artifacts/e2e-fixtures/archives/upgrade/f-upg-v1-source.tar.gz"],
  ]) {
    if (existsSync(resolveFromRepo(archivePath))) rebindArchiveHash(fixtureId, archivePath);
  }
}

if (fixtureOverlay === "zip") {
  for (const [fixtureId, deploymentId, archivePath] of [
    ["F-58-ZIP", "F-58-ZIP-testnet", "artifacts/e2e-fixtures/archives/f58-source-tree.zip"],
    ["F-58-ZIP-PUBLIC", "F-58-ZIP-PUBLIC-testnet", "artifacts/e2e-fixtures/archives/f58-public-source-tree.zip"],
  ]) {
    const fixture = inventory.contracts?.[fixtureId];
    const deployed = deployment(records, deploymentId);
    const built = buildRecord(buildRecords, deploymentId);
    if (!built.source_archive || !built.source_sha256) {
      throw new Error(`${deploymentId} build record must name the ZIP source archive and its SHA-256`);
    }
    const archive = resolveFromRepo(archivePath);
    if (!existsSync(archive)) throw new Error(`${fixtureId} source archive does not exist: ${archive}`);
    applyTarget(fixture, deployed);
    fixture.source_path = archivePath;
    fixture.source_sha256 = built.source_sha256;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(`generated ZIP E2E fixture inventory: ${outputPath}`);
  process.exit(0);
}

if (fixtureOverlay === "timeout") {
  const sub09TimeoutTarget = deployment(records, "F-SUB09-TIMEOUT-testnet");
  const sub10TimeoutTarget = deployment(records, "F-SUB10-TIMEOUT-testnet");
  const ruleDTimeoutTarget = deployment(records, "F-RULE-D-TIMEOUT-testnet");
  const sub09TimeoutFixture = inventory.contracts?.["F-SUB09-TIMEOUT"];
  const sub10TimeoutFixture = inventory.contracts?.["F-SUB10-TIMEOUT"];
  const ruleDTimeoutFixture = inventory.contracts?.["F-RULE-D-TIMEOUT"];
  applyTarget(sub09TimeoutFixture, sub09TimeoutTarget);
  applyTarget(sub10TimeoutFixture, sub10TimeoutTarget);
  applyTarget(ruleDTimeoutFixture, ruleDTimeoutTarget);
  sub09TimeoutFixture.run_scoped_target = true;
  sub10TimeoutFixture.run_scoped_target = true;
  ruleDTimeoutFixture.run_scoped_target = true;

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(`generated timeout E2E fixture inventory: ${outputPath}`);
  process.exit(0);
}

const verifiedTarget = deployment(records, "F-LEG-1-testnet");
const sub09TimeoutTarget = deployment(records, "F-SUB09-TIMEOUT-testnet");
const sub10TimeoutTarget = deployment(records, "F-SUB10-TIMEOUT-testnet");
const ruleDTimeoutTarget = deployment(records, "F-RULE-D-TIMEOUT-testnet");
const mismatchTarget = deployment(records, "F-LEG-3-target");
const s55CaseVariantTarget = deployment(records, "F-S55-E-testnet");
const s55EmptyPrefixTarget = deployment(records, "F-S55-F-testnet");
const privateCli58Target = deployment(records, "F-58-PRIV-testnet");
const privateCli58Build = buildRecord(buildRecords, "F-58-PRIV-testnet");
const zipCli58Target = deployment(records, "F-58-ZIP-testnet");
const zipCli58Build = buildRecord(buildRecords, "F-58-ZIP-testnet");
const publicZipCli58Target = deployment(records, "F-58-ZIP-PUBLIC-testnet");
const publicZipCli58Build = buildRecord(buildRecords, "F-58-ZIP-PUBLIC-testnet");

applyTarget(inventory.contracts?.["F-LEG-1"], verifiedTarget);
applyTarget(inventory.contracts?.["F-PRIV"], verifiedTarget);
applyTarget(inventory.contracts?.["F-URI-PRIV"], verifiedTarget);
// This compiler-error source deliberately fails while rebuilding F-LEG-1's run-scoped target.
applyTarget(inventory.contracts?.["F-PRIV-BUILDFAILED"], verifiedTarget);
applyTarget(inventory.contracts?.["F-SUB09-TIMEOUT"], sub09TimeoutTarget);
applyTarget(inventory.contracts?.["F-SUB10-TIMEOUT"], sub10TimeoutTarget);
applyTarget(inventory.contracts?.["F-RULE-D-TIMEOUT"], ruleDTimeoutTarget);
inventory.contracts["F-SUB09-TIMEOUT"].run_scoped_target = true;
inventory.contracts["F-SUB10-TIMEOUT"].run_scoped_target = true;
inventory.contracts["F-RULE-D-TIMEOUT"].run_scoped_target = true;
applyTarget(inventory.contracts?.["F-ADV-TOOLCHAIN"], verifiedTarget);
// The two adversarial archives plant *F-LEG-1's deployed bytes*, so they must follow F-LEG-1's deployment or
// the plant would be bytes from a contract nobody is verifying.
applyTarget(inventory.contracts?.["F-ADV-PLANT"], verifiedTarget);
applyTarget(inventory.contracts?.["F-ADV-BUILDRS"], verifiedTarget);
applyTarget(inventory.contracts?.["F-LEG-3"], mismatchTarget);
applyTarget(inventory.contracts?.["F-URI-MISMATCH"], mismatchTarget);
applyTarget(inventory.contracts?.["F-MISMATCH-ALT"], mismatchTarget);
applyTarget(inventory.contracts?.["F-S55-E"], s55CaseVariantTarget);
applyTarget(inventory.contracts?.["F-S55-F"], s55EmptyPrefixTarget);
const privateCli58Fixture = inventory.contracts?.["F-58-PRIV"];
applyTarget(privateCli58Fixture, privateCli58Target);
if (!privateCli58Build.source_archive || !privateCli58Build.source_sha256) {
  throw new Error("F-58-PRIV-testnet build record must name the private source archive and its SHA-256");
}
// The CI build runs its outer CLI under the official image UID, so it writes build output beneath a shared /tmp
// root and the workflow copies it into fixtureOutputRoot afterwards.
const privateCli58Archive = resolve(fixtureOutputRoot, "archives/private-cli58-canary.tar.gz");
if (!existsSync(privateCli58Archive)) {
  throw new Error(`F-58-PRIV source archive was not copied to ${privateCli58Archive}`);
}
privateCli58Fixture.source_path = relative(repoRoot, privateCli58Archive);
privateCli58Fixture.source_sha256 = privateCli58Build.source_sha256;

const zipCli58Fixture = inventory.contracts?.["F-58-ZIP"];
applyTarget(zipCli58Fixture, zipCli58Target);
if (!zipCli58Build.source_archive || !zipCli58Build.source_sha256) {
  throw new Error("F-58-ZIP-testnet build record must name the ZIP source archive and its SHA-256");
}
const zipCli58Archive = resolve(repoRoot, "artifacts/e2e-fixtures/archives/f58-source-tree.zip");
if (!existsSync(zipCli58Archive)) {
  throw new Error(`F-58-ZIP source archive does not exist: ${zipCli58Archive}`);
}
zipCli58Fixture.source_path = relative(repoRoot, zipCli58Archive);
zipCli58Fixture.source_sha256 = zipCli58Build.source_sha256;

const publicZipCli58Fixture = inventory.contracts?.["F-58-ZIP-PUBLIC"];
applyTarget(publicZipCli58Fixture, publicZipCli58Target);
if (!publicZipCli58Build.source_archive || !publicZipCli58Build.source_sha256) {
  throw new Error("F-58-ZIP-PUBLIC-testnet build record must name the ZIP source archive and its SHA-256");
}
const publicZipCli58Archive = resolve(repoRoot, "artifacts/e2e-fixtures/archives/f58-public-source-tree.zip");
if (!existsSync(publicZipCli58Archive)) {
  throw new Error(`F-58-ZIP-PUBLIC source archive does not exist: ${publicZipCli58Archive}`);
}
publicZipCli58Fixture.source_path = relative(repoRoot, publicZipCli58Archive);
publicZipCli58Fixture.source_sha256 = publicZipCli58Build.source_sha256;

// The compose-built fixtures, each present only once somebody has composed its image, built it and deployed it.
const COMPOSE_BUILT_FIXTURES = ["F-COMPOSE-ONLY", "F-DEMAND-01", "F-OLD-END"];
const composeHashes = new Map([["F-LEG-1", verifiedTarget.wasm_hash]]);

for (const fixtureId of COMPOSE_BUILT_FIXTURES) {
  const record = optionalDeployment(records, `${fixtureId}-testnet`);
  if (!record || !inventory.contracts?.[fixtureId]) continue;
  applyTarget(inventory.contracts[fixtureId], record);

  // `build-purpose-contracts.sh` guards this at build time; this guards a deployment set assembled across
  // machines or runs, where that guard never saw both files.
  for (const [otherId, otherHash] of composeHashes) {
    if (record.wasm_hash === otherHash) {
      throw new Error(
        `${fixtureId} and ${otherId} deployment records use the same Wasm hash (${record.wasm_hash}), ` +
          `so ${fixtureId} was not built on a different toolchain — recompose for its pair and rebuild ` +
          `it, rather than reusing whichever image was still tagged`
      );
    }
  }
  composeHashes.set(fixtureId, record.wasm_hash);
}

if (verifiedTarget.wasm_hash === mismatchTarget.wasm_hash) {
  throw new Error("F-LEG-1 and F-LEG-3 deployment records use the same Wasm hash");
}

if (performanceTargetCount !== undefined) {
  if (!Number.isInteger(performanceTargetCount) || performanceTargetCount < 1 || performanceTargetCount > 200) {
    throw new Error("SCVS_FIXTURE_PERF_TARGET_COUNT must be an integer from 1 through 200");
  }
  const performanceTargets = records
    .filter(
      (record) =>
        /^F-PERF-VERIFIED-\d+$/.test(record.fixture_id) &&
        (!expectedScope || record.deployment_scope === expectedScope)
    )
    .sort((left, right) => left.fixture_id.localeCompare(right.fixture_id));
  if (performanceTargets.length !== performanceTargetCount) {
    throw new Error(
      `expected ${performanceTargetCount} F-PERF-VERIFIED deployments, found ${performanceTargets.length}`
    );
  }
  if (performanceTargets.some((record) => record.wasm_hash !== verifiedTarget.wasm_hash)) {
    throw new Error("F-PERF-VERIFIED deployments must all use F-LEG-1's Wasm hash");
  }
  inventory.performance_verified = {
    fixture_id: "F-LEG-1",
    wasm_hash: verifiedTarget.wasm_hash,
    targets: performanceTargets.map(({ contract_id, wasm_hash }) => ({ contract_id, wasm_hash })),
  };
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`generated E2E fixture inventory: ${outputPath}`);
