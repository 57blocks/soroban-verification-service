import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "./env.js";
import { expectStatus, sha256Hex } from "./http.js";
import { preflight, uploadSource } from "./job.js";
import type { SubmitBody, SubmittedManifest, VerificationTarget } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const sourceTreeZipFixtureRelativePath = "artifacts/e2e-fixtures/archives/f58-source-tree.zip";
const sourceTreeZipFixturePath = join(repoRoot, sourceTreeZipFixtureRelativePath);
const publicSourceTreeZipFixtureRelativePath = "artifacts/e2e-fixtures/archives/f58-public-source-tree.zip";
const publicSourceTreeZipFixturePath = join(repoRoot, publicSourceTreeZipFixtureRelativePath);

export interface ContractFixture {
  readonly id: string;
  readonly network: "mainnet" | "testnet";
  readonly contract_id?: string;
  readonly wasm_hash?: string;
  readonly source_uri?: string;
  readonly source_path?: string;
  readonly source_sha256?: string;
  readonly prepared_new_wasm_hash?: string;
  readonly bldarg?: string[];
  readonly bldopt?: string[];
  readonly run_scoped_recipe?: boolean;
  readonly run_scoped_target?: boolean;
  readonly bldimg?: string;
  readonly note?: string;
}

export interface FixtureInventory {
  readonly contracts: Record<string, ContractFixture>;
  readonly performance_verified?: {
    readonly fixture_id: string;
    readonly wasm_hash: string;
    readonly targets: readonly { readonly contract_id: string; readonly wasm_hash: string }[];
  };
  readonly bulk?: {
    readonly target_fixture: string;
    readonly archive_directory: string;
    readonly count: number;
  };
  readonly images?: {
    readonly accepted?: string;
    readonly digest_pinned_untrusted?: string;
    readonly tag_only?: string;
  };
  readonly mirrored_source?: { readonly url_a: string; readonly url_b: string; readonly sha256: string };
  readonly unreachable_source_uri?: string;
}

export function fixtureInventoryPath(configured = process.env.SCVS_E2E_FIXTURES): string {
  return configured
    ? isAbsolute(configured)
      ? configured
      : join(repoRoot, configured)
    : join(here, "..", "fixtures", "e2e-fixtures.dev.json");
}

function loadInventory(): FixtureInventory {
  const path = fixtureInventoryPath();

  if (!existsSync(path)) return { contracts: {} };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FixtureInventory>;
    return { ...parsed, contracts: parsed.contracts ?? {} };
  } catch (error) {
    throw new Error(
      `Fixture inventory at ${path} is not valid JSON: ${(error as Error).message}. ` +
        `Start from fixtures/e2e-fixtures.example.json.`
    );
  }
}

export const fixtures: FixtureInventory = loadInventory();

export function sourceTreeZipFixture(): { bytes: Buffer; filename: string } {
  if (!existsSync(sourceTreeZipFixturePath)) {
    throw new Error(
      `ZIP fixture ${sourceTreeZipFixturePath} does not exist. Run test/fixtures/e2e/prepare-ci-sources.sh.`,
    );
  }
  return {
    bytes: readFileSync(sourceTreeZipFixturePath),
    filename: sourceTreeZipFixtureRelativePath.split("/").at(-1)!,
  };
}

export function sourceTreeZipFixtureProblem(): string | undefined {
  return existsSync(sourceTreeZipFixturePath)
    ? undefined
    : `ZIP fixture ${sourceTreeZipFixtureRelativePath} is absent; run test/fixtures/e2e/prepare-ci-sources.sh`;
}

export function publicSourceTreeZipFixture(): { bytes: Buffer; filename: string } {
  if (!existsSync(publicSourceTreeZipFixturePath)) {
    throw new Error(
      `ZIP fixture ${publicSourceTreeZipFixturePath} does not exist. Run test/fixtures/e2e/prepare-ci-sources.sh.`,
    );
  }
  return {
    bytes: readFileSync(publicSourceTreeZipFixturePath),
    filename: publicSourceTreeZipFixtureRelativePath.split("/").at(-1)!,
  };
}

export function publicSourceTreeZipFixtureProblem(): string | undefined {
  return existsSync(publicSourceTreeZipFixturePath)
    ? undefined
    : `ZIP fixture ${publicSourceTreeZipFixtureRelativePath} is absent; run test/fixtures/e2e/prepare-ci-sources.sh`;
}

export function missingFixture(...ids: string[]): string | undefined {
  const absent = ids.filter((id) => !fixtures.contracts[id]);
  if (absent.length === 0) return undefined;
  return `fixture ${absent.join(", ")} is not in the inventory (see fixtures/e2e-fixtures.example.json and test/fixtures/e2e/registry.yaml)`;
}

export function missingDeployedTarget(...ids: string[]): string | undefined {
  const absent = missingFixture(...ids);
  if (absent) return absent;

  const undeployed = ids.filter((id) => {
    const f = fixtures.contracts[id];
    return !f.contract_id && !f.wasm_hash;
  });
  if (undeployed.length === 0) return undefined;

  return (
    `fixture ${undeployed.join(", ")} is registered but carries no deployed contract_id/wasm_hash yet ` +
    `(see test/fixtures/e2e/registry.yaml for its status and the build/deploy commands it needs)`
  );
}

export function missingRunScopedTarget(...ids: string[]): string | undefined {
  const missing = missingDeployedTarget(...ids);
  if (missing) return missing;
  const shared = ids.filter((id) => !fixtures.contracts[id].run_scoped_target);
  return shared.length === 0
    ? undefined
    : `fixture ${shared.join(", ")} is a stable target; select the timeout case through the run-local timeout provisioner`;
}

export function fixture(id: string): ContractFixture {
  const found = fixtures.contracts[id];
  if (!found) throw new Error(`Fixture ${id} is not registered; missingFixture() should have skipped this case.`);
  return found;
}

async function uploadedArchive(path: string) {
  const resolved = isAbsolute(path) ? path : join(here, "..", "..", "..", path);
  if (!existsSync(resolved)) {
    throw new Error(
      `Fixture archive ${resolved} does not exist. Run test/fixtures/e2e/generate-fixtures.sh, or ` +
        `point the fixture at a public source_uri instead.`
    );
  }

  const bytes = readFileSync(resolved);
  const uploaded = await uploadSource(bytes, path.split("/").pop() ?? "source.tar.gz");

  if (uploaded.source_sha256 !== sha256Hex(bytes)) {
    throw new Error(
      `Upload of ${resolved} came back with source_sha256 ${uploaded.source_sha256}, but the local ` +
        `bytes hash to ${sha256Hex(bytes)}.`
    );
  }

  return { upload_id: uploaded.upload_id, source_sha256: uploaded.source_sha256 };
}

export async function uploadFixtureArchive(id: string) {
  const f = fixture(id);
  if (!f.source_path) {
    throw new Error(
      `Fixture ${id} has no source_path, so there is nothing to upload. An upload needs a local ` +
        `archive: a fixture reached through source_uri is never staged and has no staging object.`
    );
  }

  const resolved = isAbsolute(f.source_path)
    ? f.source_path
    : join(here, "..", "..", "..", f.source_path);
  if (!existsSync(resolved)) {
    throw new Error(
      `Fixture archive ${resolved} does not exist. Run test/fixtures/e2e/generate-fixtures.sh.`
    );
  }

  const bytes = readFileSync(resolved);
  const uploaded = await uploadSource(bytes, f.source_path.split("/").pop() ?? "source.tar.gz");

  if (uploaded.source_sha256 !== sha256Hex(bytes)) {
    throw new Error(
      `Upload of ${resolved} came back with source_sha256 ${uploaded.source_sha256}, but the local ` +
        `bytes hash to ${sha256Hex(bytes)}.`
    );
  }

  return { ...uploaded, localBytes: bytes.length };
}

type ChainRecipe = {
  readonly bldimg: string;
  readonly source_sha256: string;
  readonly source_uri: string;
  readonly bldarg?: string[];
  readonly bldopt?: string[];
};

export type PrivateChainRecipeSubmission = {
  readonly body: SubmitBody & { readonly manifest: NonNullable<SubmitBody["manifest"]> };
  readonly chainRecipe: ChainRecipe;
};

export async function privateUploadChainRecipeSubmissionFor(
  id: string,
): Promise<PrivateChainRecipeSubmission> {
  const target = metadataSubmissionFor(id).target;
  const inspected = await preflight(target);
  expectStatus(inspected, 200);

  const chainRecipe = readSuggestedChainRecipe(inspected.json?.suggested_manifest);
  const uploaded = await uploadFixtureArchive(id);
  if (uploaded.source_sha256 !== chainRecipe.source_sha256) {
    throw new Error(
      `Fixture ${id} upload hash ${uploaded.source_sha256} does not match the chain-recorded ` +
        `source_sha256 ${chainRecipe.source_sha256}.`,
    );
  }

  return {
    body: {
      target,
      manifest: {
        schema: "stellar-submitted-source-verification-manifest-v1",
        bldimg: chainRecipe.bldimg,
        ...(chainRecipe.bldarg ? { bldarg: chainRecipe.bldarg } : {}),
        ...(chainRecipe.bldopt ? { bldopt: chainRecipe.bldopt } : {}),
        source_sha256: uploaded.source_sha256,
        upload_id: uploaded.upload_id,
        is_public: false,
      },
    },
    chainRecipe,
  };
}

function readSuggestedChainRecipe(value: unknown): ChainRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Preflight returned no complete suggested_manifest for the cli-58 fixture.");
  }

  const manifest = value as Record<string, unknown>;
  const bldarg = optionalManifestStringArray(manifest, "bldarg");
  const bldopt = optionalManifestStringArray(manifest, "bldopt");
  return {
    bldimg: requiredManifestString(manifest, "bldimg"),
    source_sha256: requiredManifestString(manifest, "source_sha256"),
    source_uri: requiredManifestString(manifest, "source_uri"),
    ...(bldarg ? { bldarg } : {}),
    ...(bldopt ? { bldopt } : {}),
  };
}

function requiredManifestString(manifest: Record<string, unknown>, field: string): string {
  const value = manifest[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Preflight suggested_manifest.${field} must be a non-empty string.`);
  }
  return value;
}

function optionalManifestStringArray(manifest: Record<string, unknown>, field: string): string[] | undefined {
  const value = manifest[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Preflight suggested_manifest.${field} must be an array of strings when present.`);
  }
  return value;
}

const RECIPE_SCOPE_PREFIX = "--env=SCVS_E2E_RECIPE_SCOPE=";

export function runScopedBldopt(
  bldopt: readonly string[],
  runId: string,
  testName: string,
  fixtureId: string
): string[] {
  const scope = createHash("sha256")
    .update(JSON.stringify([runId, testName, fixtureId]))
    .digest("hex")
    .slice(0, 24);

  return [
    ...bldopt.filter((entry) => !entry.startsWith(RECIPE_SCOPE_PREFIX)),
    `${RECIPE_SCOPE_PREFIX}${scope}`,
  ];
}

export function recipeScopeLabel(
  state: { currentTestName?: string; testPath?: string } = expect.getState()
): string {
  return state.currentTestName ?? state.testPath ?? "suite setup";
}

export async function submissionFor(
  id: string,
  overrides: Partial<{
    target: { contract_id?: string; wasm_hash?: string };
    bldopt: string[];
    bldarg: string[];
    bldimg: string;
    source_uri: string;
    source_sha256: string;
    upload_id: string;
    is_public: boolean;
  }> = {}
): Promise<{ target: VerificationTarget; manifest: SubmittedManifest }> {
  const f = fixture(id);
  const requestedBldopt = overrides.bldopt ?? f.bldopt;
  const bldopt = f.run_scoped_recipe
    ? runScopedBldopt(requestedBldopt ?? [], env.runId, recipeScopeLabel(), id)
    : requestedBldopt;

  for (const key of ["source_uri", "upload_id", "source_sha256"] as const) {
    if (key in overrides && overrides[key] === undefined) {
      throw new Error(
        `submissionFor(${id}) was given an explicit \`${key}: undefined\`. That is almost always a ` +
          `field read off a fixture that does not carry it — use sourceOf(<id>) to spread the source ` +
          `that fixture actually has, or drop the key to inherit ${id}'s own.`
      );
    }
  }

  const overrodeSource = "source_uri" in overrides || "upload_id" in overrides;

  const uploaded =
    !overrodeSource && !f.source_uri && f.source_path ? await uploadedArchive(f.source_path) : undefined;

  const uploadId = overrides.upload_id ?? uploaded?.upload_id;
  const sourceUri = "source_uri" in overrides ? overrides.source_uri : f.source_uri;

  return {
    target: {
      network: f.network,
      ...(overrides.target?.contract_id ?? f.contract_id
        ? { contract_id: overrides.target?.contract_id ?? f.contract_id }
        : {}),
      ...(overrides.target?.contract_id ?? f.contract_id
        ? {}
        : overrides.target?.wasm_hash ?? f.wasm_hash
          ? { wasm_hash: overrides.target?.wasm_hash ?? f.wasm_hash }
          : {}),
    },
    manifest: {
      schema: "stellar-submitted-source-verification-manifest-v1" as const,
      ...(overrides.bldimg ?? f.bldimg ? { bldimg: overrides.bldimg ?? f.bldimg } : {}),
      ...(overrides.bldarg ?? f.bldarg ? { bldarg: overrides.bldarg ?? f.bldarg } : {}),
      ...(bldopt ? { bldopt } : {}),
      source_sha256:
        overrides.source_sha256 ?? uploaded?.source_sha256 ?? f.source_sha256 ?? "",
      ...(uploadId ? { upload_id: uploadId } : sourceUri ? { source_uri: sourceUri } : {}),
      ...(overrides.is_public !== undefined ? { is_public: overrides.is_public } : {}),
    },
  };
}

export async function sourceOf(
  id: string
): Promise<{ source_sha256: string } & ({ source_uri: string } | { upload_id: string })> {
  const f = fixture(id);
  if (f.source_uri) {
    if (!f.source_sha256) {
      throw new Error(`Fixture ${id} carries a source_uri but no source_sha256 to declare for it.`);
    }
    return { source_uri: f.source_uri, source_sha256: f.source_sha256 };
  }
  if (f.source_path) return await uploadedArchive(f.source_path);
  throw new Error(
    `Fixture ${id} carries neither source_uri nor source_path — it is a target-only fixture, so no ` +
      `submission can be built from its source. Pick a fixture that has one.`
  );
}

export function metadataSubmissionFor(id: string): SubmitBody {
  const f = fixture(id);
  if (f.contract_id) {
    return { target: { network: f.network, contract_id: f.contract_id } };
  }
  if (f.wasm_hash) {
    return { target: { network: f.network, wasm_hash: f.wasm_hash } };
  }
  throw new Error(`Fixture ${id} has neither contract_id nor wasm_hash for a metadata submission.`);
}
