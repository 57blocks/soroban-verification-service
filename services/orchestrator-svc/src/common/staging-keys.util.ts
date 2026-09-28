import type { BuildMode } from "@scvs/core";

// Dispatch presigns these keys and the outcome path reads them back: both must agree byte for byte.
export function recipeArtifactKey(rebuildId: string, mode: BuildMode): string {
  return `staging/${rebuildId}/${mode}/recipe.json`;
}

/** This object — not `recipe.json`'s `rebuilt_wasm_hash` — is what every verdict rests on. */
export function rebuiltWasmKey(rebuildId: string, mode: BuildMode): string {
  return `staging/${rebuildId}/${mode}/rebuilt.wasm`;
}

export function canonicalSourceKey(rebuildId: string, mode: BuildMode): string {
  return `staging/${rebuildId}/${mode}/canonical-source`;
}

// Not content-addressed: a key shared across rebuilds could be deleted while another job builds from it.
export function fetchedSourceKey(rebuildId: string, mode: BuildMode): string {
  return `staging/${rebuildId}/${mode}/fetched-source`;
}

export function paramsDocumentKey(rebuildId: string, mode: BuildMode, container: "materialise" | "runner"): string {
  return `staging/${rebuildId}/${mode}/params/${container}.json`;
}

// verification-svc serves a log only under the build-logs/ prefix.
export function buildLogKey(rebuildId: string, mode: BuildMode): string {
  return `build-logs/${rebuildId}/${mode}.log`;
}
