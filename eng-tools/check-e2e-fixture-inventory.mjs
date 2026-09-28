#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
function resolveFromRepo(path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

const configuredInventory =
  process.argv[2] ??
  process.env.SCVS_E2E_FIXTURES ??
  "test/integration/fixtures/e2e-fixtures.dev.json";
const inventoryPath = isAbsolute(configuredInventory)
  ? configuredInventory
  : resolve(repoRoot, configuredInventory);
const registryPath = resolve(repoRoot, "test/fixtures/e2e/registry.yaml");
const configuredDeployments = process.env.SCVS_FIXTURE_DEPLOYMENTS;
const deploymentsPath = configuredDeployments
  ? isAbsolute(configuredDeployments)
    ? configuredDeployments
    : resolve(repoRoot, configuredDeployments)
  : undefined;
const expectedScope = process.env.SCVS_FIXTURE_DEPLOYMENT_SCOPE;
const fixtureOutputRoot = resolveFromRepo(
  process.env.SCVS_FIXTURE_OUTPUT_ROOT ?? "artifacts/e2e-fixtures"
);
const expectedPrivateCli58SourcePath = relative(
  repoRoot,
  resolve(fixtureOutputRoot, "archives/private-cli58-canary.tar.gz")
);
const requireLocalSourceArchives = process.env.SCVS_E2E_FIXTURE_REQUIRE_LOCAL_SOURCES !== "0";
const fixtureOverlay = process.env.SCVS_E2E_FIXTURE_OVERLAY;
if (fixtureOverlay !== undefined && fixtureOverlay !== "zip" && fixtureOverlay !== "timeout") {
  throw new Error(`SCVS_E2E_FIXTURE_OVERLAY must be "zip" or "timeout" when set, received ${JSON.stringify(fixtureOverlay)}`);
}
const timeoutTargetsAreRunScoped = fixtureOverlay === "timeout" || Boolean(expectedScope);
const errors = [];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read JSON ${path}: ${error.message}`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readNdjson(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`cannot read NDJSON ${path}:${index + 1}: ${error.message}`);
      }
    });
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) errors.push(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

function expect(condition, message) {
  if (!condition) errors.push(message);
}

const inventory = readJson(inventoryPath);
const registry = parse(readFileSync(registryPath, "utf8"));
const contracts = inventory.contracts ?? {};
const fLeg1 = contracts["F-LEG-1"];
const f58Private = contracts["F-58-PRIV"];
const f58Zip = contracts["F-58-ZIP"];
const f58ZipPublic = contracts["F-58-ZIP-PUBLIC"];
const fLeg1Mainnet = contracts["F-LEG-1-MAINNET"];
const fPriv = contracts["F-PRIV"];
const fLeg3 = contracts["F-LEG-3"];
const fBuildTimeout = contracts["F-BUILD-TIMEOUT"];
const fSub09Timeout = contracts["F-SUB09-TIMEOUT"];
const fSub10Timeout = contracts["F-SUB10-TIMEOUT"];
const fRuleDTimeout = contracts["F-RULE-D-TIMEOUT"];
const fAdvToolchain = contracts["F-ADV-TOOLCHAIN"];
const mismatchAlt = contracts["F-MISMATCH-ALT"];
const multiPackage = contracts["F-MULTIPKG"];
const performanceVerified = inventory.performance_verified;
const requiredLeg1Mainnet = registry.required_contracts?.["F-LEG-1-mainnet"];
const requiredLeg3 = registry.required_contracts?.["F-LEG-3"];
const requiredBuildTimeout = registry.required_contracts?.["F-BUILD-TIMEOUT"];
const requiredSub09Timeout = registry.required_contracts?.["F-SUB09-TIMEOUT"];
const requiredSub10Timeout = registry.required_contracts?.["F-SUB10-TIMEOUT"];
const requiredRuleDTimeout = registry.required_contracts?.["F-RULE-D-TIMEOUT"];
const requiredPriv = registry.required_contracts?.["F-PRIV"];
const requiredMultiPackage = registry.required_contracts?.["F-MULTIPKG"];
const deploymentRecords = deploymentsPath ? readNdjson(deploymentsPath) : undefined;
const generatedManifestPath = resolve(repoRoot, "artifacts/e2e-fixtures/manifest.ndjson");
const generatedManifest = existsSync(generatedManifestPath)
  ? readNdjson(generatedManifestPath)
  : undefined;
const buildManifestPath = resolveFromRepo(
  `${process.env.SCVS_FIXTURE_OUTPUT_ROOT ?? "artifacts/e2e-fixtures"}/purpose-built-wasm.ndjson`,
);
const buildManifest = existsSync(buildManifestPath) ? readNdjson(buildManifestPath) : undefined;
const sourceTreeZipFixturePath = resolve(repoRoot, "artifacts/e2e-fixtures/archives/f58-source-tree.zip");
const publicSourceTreeZipFixturePath = resolve(repoRoot, "artifacts/e2e-fixtures/archives/f58-public-source-tree.zip");

const stableF58Build = buildManifest?.find((record) => record.fixture_id === "F-58-testnet");
const stableF58ContractName = registry.required_contracts?.["F-58-testnet-supplemental"]?.contract;
const stableF58Contract = stableF58ContractName ? registry.contracts?.[stableF58ContractName] : undefined;
if (stableF58Build) {
  expect(stableF58Contract, "registry is missing the stable F-58 testnet contract");
}
if (stableF58Build && stableF58Contract) {
  expectEqual("F-58 generated Wasm hash", stableF58Build.wasm_hash, stableF58Contract.wasm_hash);
  const metadataKeys = Array.isArray(stableF58Build.metadata)
    ? stableF58Build.metadata.map((entry) => entry?.sc_meta_v0?.key).filter((key) => typeof key === "string")
    : [];
  expectEqual(
    "F-58 generated metadata key sequence",
    JSON.stringify(metadataKeys),
    JSON.stringify([
      "rsver",
      "rssdkver",
      "cliver",
      "bldimg",
      "source_uri",
      "source_sha256",
      "bldopt",
      "bldopt",
      "bldopt",
      "bldopt",
    ]),
  );
}

const stableS55DBuild = buildManifest?.find((record) => record.fixture_id === "F-S55-D");
const stableS55DContractName = registry.required_contracts?.["F-S55-D"]?.contract;
const stableS55DContract = stableS55DContractName ? registry.contracts?.[stableS55DContractName] : undefined;
if (stableS55DBuild) {
  expect(stableS55DContract, "registry is missing the stable F-S55-D testnet contract");
}
if (stableS55DBuild && stableS55DContract) {
  expectEqual("F-S55-D generated Wasm hash", stableS55DBuild.wasm_hash, stableS55DContract.wasm_hash);
}

expect(fLeg1, "inventory is missing F-LEG-1");
expect(f58Private, "inventory is missing F-58-PRIV");
expect(f58Zip, "inventory is missing F-58-ZIP");
expect(f58ZipPublic, "inventory is missing F-58-ZIP-PUBLIC");
expect(fLeg1Mainnet, "inventory is missing F-LEG-1-MAINNET");
expect(fPriv, "inventory is missing F-PRIV");
expect(fLeg3, "inventory is missing F-LEG-3");
expect(fBuildTimeout, "inventory is missing F-BUILD-TIMEOUT");
expect(fSub09Timeout, "inventory is missing F-SUB09-TIMEOUT");
expect(fSub10Timeout, "inventory is missing F-SUB10-TIMEOUT");
expect(fRuleDTimeout, "inventory is missing F-RULE-D-TIMEOUT");
expect(fAdvToolchain, "inventory is missing F-ADV-TOOLCHAIN");
expect(mismatchAlt, "inventory is missing F-MISMATCH-ALT");
expect(multiPackage, "inventory is missing F-MULTIPKG");
expectEqual("registry F-LEG-3 status", requiredLeg3?.status, "ready");
expectEqual("registry F-LEG-1-mainnet status", requiredLeg1Mainnet?.status, "ready");
expectEqual("registry F-BUILD-TIMEOUT status", requiredBuildTimeout?.status, "ready");
expectEqual("registry F-SUB09-TIMEOUT status", requiredSub09Timeout?.status, "ready");
expectEqual("registry F-SUB10-TIMEOUT status", requiredSub10Timeout?.status, "ready");
expectEqual(
  "registry F-BUILD-TIMEOUT source_record",
  requiredBuildTimeout?.source_record,
  "build-timeout"
);
expectEqual("registry F-RULE-D-TIMEOUT status", requiredRuleDTimeout?.status, "ready");
expectEqual("registry F-PRIV status", requiredPriv?.status, "ready");
expectEqual("registry F-PRIV source record", requiredPriv?.source_record, "private-canary");
expectEqual("registry F-MULTIPKG status", requiredMultiPackage?.status, "ready");

expect(performanceVerified, "inventory is missing performance_verified");
if (performanceVerified && fLeg1) {
  expectEqual("performance_verified fixture_id", performanceVerified.fixture_id, "F-LEG-1");
  expectEqual("performance_verified wasm_hash", performanceVerified.wasm_hash, fLeg1.wasm_hash);
  const performanceTargets = Array.isArray(performanceVerified.targets)
    ? performanceVerified.targets
    : [];
  expect(
    performanceTargets.length > 0,
    "performance_verified must declare at least one target"
  );
  const targetIds = performanceTargets.map((target) => target.contract_id);
  expect(
    targetIds.every((contractId) => /^C[A-Z2-7]{55}$/.test(contractId)),
    "performance_verified contains an invalid contract_id"
  );
  expect(
    new Set(targetIds).size === targetIds.length,
    "performance_verified contains duplicate contract_ids"
  );
  expect(
    performanceTargets.every((target) => target.wasm_hash === fLeg1.wasm_hash),
    "performance_verified targets must all carry F-LEG-1's wasm_hash"
  );
}

const mainnetContractName = requiredLeg1Mainnet?.contract;
const registeredMainnet = mainnetContractName ? registry.contracts?.[mainnetContractName] : undefined;
expect(typeof mainnetContractName === "string", "registry F-LEG-1-mainnet has no contract");
expect(
  registeredMainnet,
  `registry F-LEG-1-mainnet contract ${JSON.stringify(mainnetContractName)} does not exist`
);
expectEqual("F-LEG-1-mainnet registry contract status", registeredMainnet?.status, "ready");
expect(
  registeredMainnet?.fixture_roles?.includes("F-LEG-1-mainnet"),
  `registry contract ${JSON.stringify(mainnetContractName)} does not carry fixture role F-LEG-1-mainnet`
);
if (fLeg1Mainnet && registeredMainnet) {
  expectEqual("F-LEG-1-MAINNET contract_id", fLeg1Mainnet.contract_id, registeredMainnet.contract_id);
  expectEqual("F-LEG-1-MAINNET wasm_hash", fLeg1Mainnet.wasm_hash, registeredMainnet.wasm_hash);
  expectEqual("F-LEG-1-MAINNET network", fLeg1Mainnet.network, registeredMainnet.network);
  expectEqual("F-LEG-1-MAINNET source_uri", fLeg1Mainnet.source_uri, registeredMainnet.source_uri);
  expectEqual("F-LEG-1-MAINNET source_sha256", fLeg1Mainnet.source_sha256, registeredMainnet.source_sha256);
  expectEqual("F-LEG-1-MAINNET run_scoped_recipe", fLeg1Mainnet.run_scoped_recipe, true);
  expectEqual(
    "F-LEG-1-MAINNET bldarg",
    JSON.stringify(fLeg1Mainnet.bldarg),
    JSON.stringify(registeredMainnet.submitted_recipe?.bldarg)
  );
  expectEqual(
    "F-LEG-1-MAINNET bldopt",
    JSON.stringify(fLeg1Mainnet.bldopt),
    JSON.stringify(registeredMainnet.submitted_recipe?.bldopt)
  );
}

const multiPackageContractName = requiredMultiPackage?.contract;
const registeredMultiPackage = multiPackageContractName
  ? registry.contracts?.[multiPackageContractName]
  : undefined;
expect(typeof multiPackageContractName === "string", "registry F-MULTIPKG has no contract");
expect(
  registeredMultiPackage,
  `registry F-MULTIPKG contract ${JSON.stringify(multiPackageContractName)} does not exist`
);
expectEqual("F-MULTIPKG registry contract status", registeredMultiPackage?.status, "ready");
expect(
  registeredMultiPackage?.fixture_roles?.includes("F-MULTIPKG"),
  `registry contract ${JSON.stringify(multiPackageContractName)} does not carry fixture role F-MULTIPKG`
);
if (multiPackage && registeredMultiPackage) {
  expectEqual("F-MULTIPKG contract_id", multiPackage.contract_id, registeredMultiPackage.contract_id);
  expectEqual("F-MULTIPKG wasm_hash", multiPackage.wasm_hash, registeredMultiPackage.wasm_hash);
  expectEqual("F-MULTIPKG network", multiPackage.network, registeredMultiPackage.network);
  if (!expectedScope) {
    expectEqual("F-MULTIPKG source_sha256", multiPackage.source_sha256, registeredMultiPackage.source_sha256);
  }
  expect(
    multiPackage.bldopt?.length === 1 &&
      multiPackage.bldopt[0] === "--manifest-path=contracts/contract-b/Cargo.toml",
    "F-MULTIPKG must select contract-b with one equals-form --manifest-path option"
  );
}

if (fPriv && fLeg1) {
  expectEqual("F-PRIV contract_id", fPriv.contract_id, fLeg1.contract_id);
  expectEqual("F-PRIV wasm_hash", fPriv.wasm_hash, fLeg1.wasm_hash);
  expectEqual("F-PRIV network", fPriv.network, fLeg1.network);
  expectEqual(
    "F-PRIV source_path",
    fPriv.source_path,
    "artifacts/e2e-fixtures/archives/private-canary.tar.gz"
  );
  expect(
    fPriv.source_sha256 !== fLeg1.source_sha256,
    "F-PRIV source hash must be distinct from F-LEG-1 so public SRC-01 cannot mask retention"
  );
  expectEqual("F-PRIV run_scoped_recipe", fPriv.run_scoped_recipe, true);
  expectEqual("F-PRIV bldarg", JSON.stringify(fPriv.bldarg), JSON.stringify(fLeg1.bldarg));
  expectEqual("F-PRIV bldopt", JSON.stringify(fPriv.bldopt), JSON.stringify(fLeg1.bldopt));

  if (generatedManifest) {
    const privateRecords = generatedManifest.filter((record) => record.id === "private-canary");
    expect(
      privateRecords.length === 1,
      `generated fixture manifest must contain exactly one private-canary record; found ${privateRecords.length}`
    );
    const privateRecord = privateRecords[0];
    if (privateRecord) {
      expectEqual("F-PRIV manifest path", privateRecord.path, fPriv.source_path);
      expectEqual("F-PRIV manifest sha256", privateRecord.sha256, fPriv.source_sha256);
    }
  }
}

if (fBuildTimeout && fSub09Timeout && fSub10Timeout && fRuleDTimeout) {
  expectEqual("F-BUILD-TIMEOUT network", fBuildTimeout.network, fSub09Timeout.network);
  expectEqual("F-BUILD-TIMEOUT network", fBuildTimeout.network, fSub10Timeout.network);
  expectEqual("F-BUILD-TIMEOUT network", fBuildTimeout.network, fRuleDTimeout.network);
  expect(
    fBuildTimeout.contract_id === undefined && fBuildTimeout.wasm_hash === undefined,
    "F-BUILD-TIMEOUT is a source-only fixture; timeout cases must explicitly select their run-scoped target",
  );
  expectEqual(
    "F-BUILD-TIMEOUT source_path",
    fBuildTimeout.source_path,
    "artifacts/e2e-fixtures/archives/build-timeout.tar.gz"
  );
  expectEqual("F-BUILD-TIMEOUT run_scoped_recipe", fBuildTimeout.run_scoped_recipe, true);
  expectEqual("F-BUILD-TIMEOUT bldarg", JSON.stringify(fBuildTimeout.bldarg), JSON.stringify(fLeg1.bldarg));
  expectEqual("F-BUILD-TIMEOUT bldopt", JSON.stringify(fBuildTimeout.bldopt), JSON.stringify(fLeg1.bldopt));
}

if (fAdvToolchain && fLeg1) {
  expectEqual("F-ADV-TOOLCHAIN contract_id", fAdvToolchain.contract_id, fLeg1.contract_id);
  expectEqual("F-ADV-TOOLCHAIN wasm_hash", fAdvToolchain.wasm_hash, fLeg1.wasm_hash);
  expectEqual("F-ADV-TOOLCHAIN network", fAdvToolchain.network, fLeg1.network);
  expectEqual(
    "F-ADV-TOOLCHAIN source_path",
    fAdvToolchain.source_path,
    "artifacts/e2e-fixtures/archives/toolchain-selector.tar.gz"
  );
  expectEqual("F-ADV-TOOLCHAIN run_scoped_recipe", fAdvToolchain.run_scoped_recipe, true);
  expectEqual("F-ADV-TOOLCHAIN bldarg", JSON.stringify(fAdvToolchain.bldarg), JSON.stringify(fLeg1.bldarg));
  expectEqual("F-ADV-TOOLCHAIN bldopt", JSON.stringify(fAdvToolchain.bldopt), JSON.stringify(fLeg1.bldopt));

  if (generatedManifest) {
    const records = generatedManifest.filter((record) => record.id === "toolchain-selector");
    expect(
      records.length === 1,
      `generated fixture manifest must contain exactly one toolchain-selector record; found ${records.length}`
    );
    const record = records[0];
    if (record) {
      expectEqual("F-ADV-TOOLCHAIN manifest path", record.path, fAdvToolchain.source_path);
      expectEqual("F-ADV-TOOLCHAIN manifest sha256", record.sha256, fAdvToolchain.source_sha256);
    }
  }
}

const imagePolicyFixtures = [
  {
    id: "F-BADIMG-TAG",
    expectedImage: "docker.io/stellar/stellar-cli:25.2.0",
  },
  {
    id: "F-BADIMG-UNTRUSTED",
    expectedImage:
      "docker.io/library/rust@sha256:4732ca96fd086cb9be682050c3f0176288eebaac2b80aa2bcefccfaf198e1950",
  },
];

for (const { id, expectedImage } of imagePolicyFixtures) {
  const fixture = contracts[id];
  const required = registry.required_contracts?.[id];
  const contractName = required?.contract;
  const registered = contractName ? registry.contracts?.[contractName] : undefined;

  expect(fixture, `inventory is missing ${id}`);
  expectEqual(`registry ${id} status`, required?.status, "ready");
  expect(typeof contractName === "string", `registry ${id} has no contract`);
  expect(registered, `registry ${id} contract ${JSON.stringify(contractName)} does not exist`);
  expectEqual(`${id} registry status`, registered?.status, "ready");
  expect(
    registered?.fixture_roles?.includes(id),
    `registry contract ${JSON.stringify(contractName)} does not carry fixture role ${id}`
  );

  if (fixture && registered) {
    expectEqual(`${id} contract_id`, fixture.contract_id, registered.contract_id);
    expectEqual(`${id} wasm_hash`, fixture.wasm_hash, registered.wasm_hash);
    expectEqual(`${id} network`, fixture.network, registered.network);
    expectEqual(`${id} bldimg`, registered.bldimg, expectedImage);
  }
}

const sep55Fixtures = [
  { id: "F-S55-A", prefixed: true, legacyRecipe: true, sourceRepo: "github:example/contract" },
  { id: "F-S55-B", prefixed: false, legacyRecipe: true, sourceRepo: "https://example.com/src.tar.gz" },
  { id: "F-S55-C", prefixed: false, legacyRecipe: true, sourceRepo: "https://mirror.example.com/github:foo" },
  { id: "F-S55-D", prefixed: true, legacyRecipe: false, sourceRepo: "github:example/contract" },
  { id: "F-S55-E", prefixed: false, legacyRecipe: true, sourceRepo: "GitHub:example/contract", runScoped: true },
  { id: "F-S55-F", prefixed: true, legacyRecipe: true, sourceRepo: "github:", runScoped: true },
];
const sep55WasmHashes = [];

for (const { id, prefixed, legacyRecipe, sourceRepo: expectedSourceRepo, runScoped = false } of sep55Fixtures) {
  const fixture = contracts[id];
  const required = registry.required_contracts?.[id];
  const contractName = required?.contract;
  const registered = contractName ? registry.contracts?.[contractName] : undefined;

  expect(fixture, `inventory is missing ${id}`);
  expectEqual(`registry ${id} status`, required?.status, "ready");
  if (runScoped) {
    expectEqual(`${id} registry deployment`, required?.deployment, "run_scoped");
    expectEqual(`${id} registry source_repo`, required?.source_repo, expectedSourceRepo);
  } else {
    expect(typeof contractName === "string", `registry ${id} has no contract`);
    expect(registered, `registry ${id} contract ${JSON.stringify(contractName)} does not exist`);
    expectEqual(`${id} registry status`, registered?.status, "ready");
    expect(
      registered?.fixture_roles?.includes(id),
      `registry contract ${JSON.stringify(contractName)} does not carry fixture role ${id}`
    );
    expectEqual(`${id} registry source_repo`, registered?.source_repo, expectedSourceRepo);
  }

  if (!fixture || (!runScoped && !registered)) continue;

  if (runScoped) {
    expectEqual(`${id} run_scoped_recipe`, fixture.run_scoped_recipe, true);
    if (expectedScope) {
      const deployed = deployment(`${id}-testnet`);
      expectEqual(`${id} contract_id`, fixture.contract_id, deployed?.contract_id);
      expectEqual(`${id} wasm_hash`, fixture.wasm_hash, deployed?.wasm_hash);
      expectEqual(`${id} network`, fixture.network, deployed?.network);
      const sourceRepos = Array.isArray(deployed?.metadata)
        ? deployed.metadata
            .filter((entry) => entry?.sc_meta_v0?.key === "source_repo")
            .map((entry) => entry.sc_meta_v0.val)
        : [];
      expect(
        sourceRepos.includes(expectedSourceRepo),
        `${id} deployed metadata has no source_repo=${JSON.stringify(expectedSourceRepo)}`
      );
    }
  } else {
    expectEqual(`${id} contract_id`, fixture.contract_id, registered.contract_id);
    expectEqual(`${id} wasm_hash`, fixture.wasm_hash, registered.wasm_hash);
    expectEqual(`${id} network`, fixture.network, registered.network);
  }
  if (typeof fixture.wasm_hash === "string") sep55WasmHashes.push(fixture.wasm_hash);

  expectEqual(`${id} source_repo begins github:`, expectedSourceRepo.startsWith("github:"), prefixed);
  if (id === "F-S55-C") {
    expect(
      expectedSourceRepo.includes("github:"),
      "F-S55-C source_repo must still contain `github:` somewhere, or it no longer distinguishes startsWith from includes"
    );
  }

  if (!legacyRecipe) {
    expect(
      fixture.bldopt === undefined && fixture.bldarg === undefined && fixture.bldimg === undefined,
      `${id} is cli-58 and is submitted target-only; a recipe in the inventory would change what E2E-SEP55-04 tests`
    );
    continue;
  }

  if (!runScoped) {
    expectEqual(
      `${id} bldopt`,
      JSON.stringify(fixture.bldopt),
      JSON.stringify(registered.submitted_recipe?.bldopt)
    );
    expectEqual(`${id} source_uri`, fixture.source_uri, registered.submitted_recipe?.source_uri);
    expectEqual(
      `${id} source_sha256`,
      fixture.source_sha256,
      registered.submitted_recipe?.source_sha256
    );
  }

  expectEqual(`${id} run_scoped_recipe`, fixture.run_scoped_recipe, true);
}

expect(
  new Set(sep55WasmHashes).size === sep55WasmHashes.length,
  `the SEP-55 fixtures must carry distinct wasm_hashes; got ${JSON.stringify(sep55WasmHashes)}`
);

const targetName = requiredLeg3?.target;
const target = targetName ? registry.contracts?.[targetName] : undefined;
expect(typeof targetName === "string", "registry F-LEG-3 has no target");
expect(target, `registry F-LEG-3 target ${JSON.stringify(targetName)} does not exist`);
expectEqual("dedicated target status", target?.status, "ready");
expect(
  target?.fixture_roles?.includes("F-LEG-3-target"),
  `registry target ${JSON.stringify(targetName)} does not carry fixture role F-LEG-3-target`
);

function deployment(fixtureId) {
  if (!deploymentRecords) return undefined;
  const matches = deploymentRecords.filter(
    (record) =>
      record.fixture_id === fixtureId &&
      (!expectedScope || record.deployment_scope === expectedScope)
  );
  expect(
    matches.length === 1,
    `deployment evidence must contain exactly one ${fixtureId}${expectedScope ? ` for scope ${expectedScope}` : ""}; found ${matches.length}`
  );
  return matches.length === 1 ? matches[0] : undefined;
}

const standardOverlay = fixtureOverlay === undefined;
const verifiedDeployment = standardOverlay ? deployment("F-LEG-1-testnet") : undefined;
const mismatchDeployment = standardOverlay ? deployment("F-LEG-3-target") : undefined;
const privateCli58Deployment = standardOverlay ? deployment("F-58-PRIV-testnet") : undefined;
const timeoutDeploymentExpected = fixtureOverlay === "timeout" || Boolean(expectedScope);
const sub09TimeoutDeployment = timeoutDeploymentExpected ? deployment("F-SUB09-TIMEOUT-testnet") : undefined;
const sub10TimeoutDeployment = timeoutDeploymentExpected ? deployment("F-SUB10-TIMEOUT-testnet") : undefined;
const ruleDTimeoutDeployment = timeoutDeploymentExpected ? deployment("F-RULE-D-TIMEOUT-testnet") : undefined;
const zipCli58Deployment = fixtureOverlay === "zip" ? deployment("F-58-ZIP-testnet") : undefined;
const publicZipCli58Deployment = fixtureOverlay === "zip" ? deployment("F-58-ZIP-PUBLIC-testnet") : undefined;

if (standardOverlay && fLeg1 && fLeg3 && mismatchAlt && target) {
  const expectedMismatchTarget = mismatchDeployment ?? target;
  expectEqual("F-LEG-3 contract_id", fLeg3.contract_id, expectedMismatchTarget.contract_id);
  expectEqual("F-LEG-3 wasm_hash", fLeg3.wasm_hash, expectedMismatchTarget.wasm_hash);
  expectEqual("F-LEG-3 network", fLeg3.network, expectedMismatchTarget.network);
  expectEqual("F-MISMATCH-ALT contract_id", mismatchAlt.contract_id, fLeg3.contract_id);
  expectEqual("F-MISMATCH-ALT wasm_hash", mismatchAlt.wasm_hash, fLeg3.wasm_hash);
  if (!expectedScope) {
    expectEqual("F-LEG-3 source_sha256", fLeg3.source_sha256, requiredLeg3.source_sha256);
  }
  expect(fLeg1.wasm_hash !== fLeg3.wasm_hash, "F-LEG-1 and F-LEG-3 must use different Wasm hashes");
  expect(
    requiredLeg3.expected_build_wasm_hash !== fLeg3.wasm_hash,
    "F-LEG-3 candidate build hash must differ from its target hash"
  );

  for (const fixture of [fLeg1, fLeg3, mismatchAlt]) {
    expectEqual(`${fixture.id} run_scoped_recipe`, fixture.run_scoped_recipe, true);
  }

  if (verifiedDeployment) {
    expectEqual("F-LEG-1 contract_id", fLeg1.contract_id, verifiedDeployment.contract_id);
    expectEqual("F-LEG-1 wasm_hash", fLeg1.wasm_hash, verifiedDeployment.wasm_hash);
    expectEqual("F-LEG-1 network", fLeg1.network, verifiedDeployment.network);
  }
}

if (timeoutTargetsAreRunScoped && fSub09Timeout && fSub10Timeout && fRuleDTimeout && fLeg1) {
  expectEqual("F-SUB09-TIMEOUT run-scoped target", fSub09Timeout.run_scoped_target, true);
  expectEqual("F-SUB10-TIMEOUT run-scoped target", fSub10Timeout.run_scoped_target, true);
  expectEqual("F-RULE-D-TIMEOUT run-scoped target", fRuleDTimeout.run_scoped_target, true);
  expectEqual("F-SUB09-TIMEOUT contract_id", fSub09Timeout.contract_id, sub09TimeoutDeployment?.contract_id);
  expectEqual("F-SUB10-TIMEOUT contract_id", fSub10Timeout.contract_id, sub10TimeoutDeployment?.contract_id);
  expectEqual("F-RULE-D-TIMEOUT contract_id", fRuleDTimeout.contract_id, ruleDTimeoutDeployment?.contract_id);
  const timeoutContractIds = [
    fSub09Timeout.contract_id,
    fSub10Timeout.contract_id,
    fRuleDTimeout.contract_id,
  ];
  expect(
    timeoutContractIds.every((contractId) => typeof contractId === "string"),
    "run-scoped timeout targets must all have contract IDs",
  );
  expect(new Set(timeoutContractIds).size === timeoutContractIds.length, "timeout targets must have distinct contract IDs");
  expect(fSub09Timeout.contract_id !== fLeg1.contract_id, "F-SUB09-TIMEOUT must differ from F-LEG-1");
  expect(fSub10Timeout.contract_id !== fLeg1.contract_id, "F-SUB10-TIMEOUT must differ from F-LEG-1");
  expect(fRuleDTimeout.contract_id !== fLeg1.contract_id, "F-RULE-D-TIMEOUT must differ from F-LEG-1");
  expectEqual("F-SUB09-TIMEOUT wasm_hash", fSub09Timeout.wasm_hash, fLeg1.wasm_hash);
  expectEqual("F-SUB10-TIMEOUT wasm_hash", fSub10Timeout.wasm_hash, fLeg1.wasm_hash);
  expectEqual("F-RULE-D-TIMEOUT wasm_hash", fRuleDTimeout.wasm_hash, fLeg1.wasm_hash);
}

if (f58Private && privateCli58Deployment) {
  expectEqual("F-58-PRIV contract_id", f58Private.contract_id, privateCli58Deployment.contract_id);
  expectEqual("F-58-PRIV wasm_hash", f58Private.wasm_hash, privateCli58Deployment.wasm_hash);
  expectEqual("F-58-PRIV network", f58Private.network, privateCli58Deployment.network);
  expectEqual(
    "F-58-PRIV source_path",
    f58Private.source_path,
    expectedPrivateCli58SourcePath
  );
  expect(
    f58Private.source_sha256 !== fLeg1?.source_sha256,
    "F-58-PRIV source hash must be run-scoped and distinct from F-LEG-1"
  );
}

if (f58Zip && zipCli58Deployment) {
  expectEqual("F-58-ZIP contract_id", f58Zip.contract_id, zipCli58Deployment.contract_id);
  expectEqual("F-58-ZIP wasm_hash", f58Zip.wasm_hash, zipCli58Deployment.wasm_hash);
  expectEqual("F-58-ZIP network", f58Zip.network, zipCli58Deployment.network);
  expectEqual(
    "F-58-ZIP source_path",
    f58Zip.source_path,
    "artifacts/e2e-fixtures/archives/f58-source-tree.zip"
  );
}

if (f58ZipPublic && publicZipCli58Deployment) {
  expectEqual("F-58-ZIP-PUBLIC contract_id", f58ZipPublic.contract_id, publicZipCli58Deployment.contract_id);
  expectEqual("F-58-ZIP-PUBLIC wasm_hash", f58ZipPublic.wasm_hash, publicZipCli58Deployment.wasm_hash);
  expectEqual("F-58-ZIP-PUBLIC network", f58ZipPublic.network, publicZipCli58Deployment.network);
  expectEqual(
    "F-58-ZIP-PUBLIC source_path",
    f58ZipPublic.source_path,
    "artifacts/e2e-fixtures/archives/f58-public-source-tree.zip"
  );
  expect(
    f58ZipPublic.source_sha256 !== f58Zip?.source_sha256,
    "F-58-ZIP-PUBLIC source hash must differ from F-58-ZIP"
  );
}

for (const [id, fixture] of Object.entries(contracts)) {
  if (fixture.contract_id) {
    expect(/^C[A-Z2-7]{55}$/.test(fixture.contract_id), `${id} has an invalid contract_id`);
  }
  if (fixture.wasm_hash) {
    expect(/^[0-9a-f]{64}$/.test(fixture.wasm_hash), `${id} has an invalid wasm_hash`);
  }
  if (fixture.source_sha256) {
    expect(/^[0-9a-f]{64}$/.test(fixture.source_sha256), `${id} has an invalid source_sha256`);
  }
  if (!fixture.source_path || !requireLocalSourceArchives) continue;

  const sourcePath = isAbsolute(fixture.source_path)
    ? fixture.source_path
    : resolve(repoRoot, fixture.source_path);
  if (!existsSync(sourcePath)) {
    errors.push(`${id} source archive does not exist: ${sourcePath}`);
    continue;
  }
  expectEqual(`${id} source archive hash`, sha256(sourcePath), fixture.source_sha256);
}

if (requireLocalSourceArchives) {
  for (const fixturePath of [sourceTreeZipFixturePath, publicSourceTreeZipFixturePath]) {
    expect(existsSync(fixturePath), `F-58 ZIP fixture does not exist: ${fixturePath}`);
    if (!existsSync(fixturePath)) continue;
    const bytes = readFileSync(fixturePath);
    expect(
      bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      `F-58 ZIP fixture is not a ZIP archive: ${fixturePath}`
    );
  }
}

if (errors.length > 0) {
  console.error(`E2E fixture inventory check failed (${errors.length}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`E2E fixture inventory is consistent: ${inventoryPath}`);
