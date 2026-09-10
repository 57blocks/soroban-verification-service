import { buildRecipeArtifact } from "../src/modules/builder/recipe.js";
import type { RunCliResult } from "../src/modules/builder/run-cli.types.js";
import { BUILD_ARTIFACT_SCHEMA_VERSION, type BuildRecipe } from "@scvs/core";

/**
 * `recipe.json` is the **only** channel out of the sandbox — `orchestrator-svc` reconstructs the whole outcome
 * from this file and never reads the container's logs.
 */
const RECIPE: BuildRecipe = {
  image: `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`,
  workspace_path: "/tmp/scvs-manual-src-DmEa85/source",
  target: "wasm32v1-none",
  bldopt: ["--locked", "--package=verified-demo", "--optimize"],
} as BuildRecipe;

/** Shaped exactly like `cliFailure("manifest_path_not_found", ...)`'s return value. */
const manifestNotFound: RunCliResult = {
  outcome: "cli_failure",
  runner: "docker_build_image_rebuild",
  exit_code: null,
  reason: "manifest_path_not_found",
  diagnostics: {
    reason: "manifest_path_not_found",
    runner: "docker_build_image_rebuild",
    source_root: "/tmp/scvs-manual-src-DmEa85/source",
    manifest_path: "/tmp/scvs-manual-src-DmEa85/source/Cargo.toml",
  },
};

/** The other side of the same function: a clean rebuild, no reason and no context. */
const success: RunCliResult = {
  outcome: "verified",
  runner: "stellar_contract_verify",
  exit_code: 0,
  rebuilt_wasm_hash: "5".repeat(64),
  rebuilt_wasm_size_bytes: 947,
  diagnostics: { runner: "stellar_contract_verify" },
};

describe("buildRecipeArtifact failure reporting", () => {
  it("carries the reason out of the sandbox even with no sandbox_diagnostics", () => {
    const artifact = buildRecipeArtifact(RECIPE, manifestNotFound);

    expect(artifact.classification).toBe("cli_failure");
    expect(artifact.exit_code).toBeNull();
    expect(artifact.reason).toBe("manifest_path_not_found");
    expect(artifact.failure_context).toMatchObject({
      source_root: "/tmp/scvs-manual-src-DmEa85/source",
      manifest_path: "/tmp/scvs-manual-src-DmEa85/source/Cargo.toml",
    });
    // This path genuinely has no schema-conformant diagnostics — that is the case being covered.
    expect(artifact.diagnostics).toBeUndefined();
  });

  it("drops an oversized context rather than growing the artifact without bound", () => {
    const artifact = buildRecipeArtifact(RECIPE, {
      ...manifestNotFound,
      reason: "dependency_prefetch_failed",
      diagnostics: {
        reason: "dependency_prefetch_failed",
        // Stands in for an embedded CommandResult carrying a whole build's stderr.
        prefetch: { stderr: "x".repeat(20_000) },
      },
    });

    expect(artifact.reason).toBe("dependency_prefetch_failed");
    expect(artifact.failure_context).toEqual({
      omitted: "too_large",
      reason: "dependency_prefetch_failed",
    });
  });

  /**
   * `schema_version` is `@IsOptional()` on the DTO — a reader must go on accepting the pre-versioning documents
   * already in S3 — so nothing in the type system says the builder always writes it.
   */
  it("stamps the contract version on every artifact, whatever the outcome", () => {
    for (const result of [manifestNotFound, success]) {
      expect(buildRecipeArtifact(RECIPE, result).schema_version).toBe(BUILD_ARTIFACT_SCHEMA_VERSION);
    }
  });

  it("adds neither field on a successful build", () => {
    const artifact = buildRecipeArtifact(RECIPE, success);

    expect(artifact.reason).toBeUndefined();
    expect(artifact.failure_context).toBeUndefined();
  });
});
