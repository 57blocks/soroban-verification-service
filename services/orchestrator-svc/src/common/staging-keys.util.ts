import type { BuildMode } from "@scvs/core";

/**
 * The staging keys a rebuild's Batch job writes to, in one place because **two modules must agree on them byte
 * for byte**: `batch-dispatch.service.ts` presigns them before dispatch, and `rebuild-outcome.service.ts` reads
 * them back after the terminal event.
 */
export function recipeArtifactKey(rebuildId: string, mode: BuildMode): string {
  return `staging/${rebuildId}/${mode}/recipe.json`;
}

/** This object — not `recipe.json`'s `rebuilt_wasm_hash` — is what every verdict rests on. */
export function rebuiltWasmKey(rebuildId: string, mode: BuildMode): string {
  return `staging/${rebuildId}/${mode}/rebuilt.wasm`;
}

/**
 * Absent is not a failure by itself — `BuildArtifact.source_canonicalisation.uploaded` says whether anything
 * was meant to be here, and only a `true` with no object is an anomaly.
 */
export function canonicalSourceKey(rebuildId: string, mode: BuildMode): string {
  return `staging/${rebuildId}/${mode}/canonical-source`;
}

/**
 * Rebuild-and-mode scoped like its siblings, and deliberately not content-addressed: a key shared across
 * rebuilds would need `deleteStagedUpload`'s outstanding-obligation reasoning to avoid deleting bytes another
 * job is still building from.
 */
export function fetchedSourceKey(rebuildId: string, mode: BuildMode): string {
  return `staging/${rebuildId}/${mode}/fetched-source`;
}

/**
 * The builder fetches its own blob by presigned GET (`SCVS_JOB_PARAMS_URL`) instead of receiving the JSON
 * inline, which is what keeps the SubmitJob override bounded: two ~1.8 KB URLs instead of two multi-kilobyte
 * documents, with no dependency on the source's metadata size.
 */
export function paramsDocumentKey(rebuildId: string, mode: BuildMode, container: "materialise" | "runner"): string {
  return `staging/${rebuildId}/${mode}/params/${container}.json`;
}

/** The prefix is the check, so the key must satisfy it. */
export function buildLogKey(rebuildId: string, mode: BuildMode): string {
  return `build-logs/${rebuildId}/${mode}.log`;
}
