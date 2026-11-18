import { buildModes, type BuildMode } from "@scvs/core";

/**
 * Where one dispatch's own objects sit. Each dispatch draws a fresh nonce, so a link minted for an earlier
 * dispatch, which stays valid after its job is gone, can neither read a later dispatch's parameters nor overwrite
 * its outputs. A rebuild dispatched before nonces existed has none, and keeps the old layout.
 */
function dispatchPrefix(rebuildId: string, mode: BuildMode, dispatchNonce?: string): string {
  return dispatchNonce ? `staging/${rebuildId}/${mode}/${dispatchNonce}` : `staging/${rebuildId}/${mode}`;
}

// Dispatch presigns these keys and the outcome path reads them back: both must agree byte for byte.
export function recipeArtifactKey(rebuildId: string, mode: BuildMode, dispatchNonce?: string): string {
  return `${dispatchPrefix(rebuildId, mode, dispatchNonce)}/recipe.json`;
}

/** This object — not `recipe.json`'s `rebuilt_wasm_hash` — is what every verdict rests on. */
export function rebuiltWasmKey(rebuildId: string, mode: BuildMode, dispatchNonce?: string): string {
  return `${dispatchPrefix(rebuildId, mode, dispatchNonce)}/rebuilt.wasm`;
}

export function canonicalSourceKey(rebuildId: string, mode: BuildMode, dispatchNonce?: string): string {
  return `${dispatchPrefix(rebuildId, mode, dispatchNonce)}/canonical-source`;
}

/** Everything a rebuild's dispatches stage under, whatever their nonces. */
export function rebuildStagingPrefix(rebuildId: string): string {
  return `staging/${rebuildId}/`;
}

/** A staged copy of a rebuild's source, under any mode and any dispatch. */
export function isStagedSourceKey(key: string): boolean {
  return /\/(fetched-source|canonical-source)$/.test(key);
}

// Not content-addressed: a key shared across rebuilds could be deleted while another job builds from it.
export function fetchedSourceKey(rebuildId: string, mode: BuildMode): string {
  return `staging/${rebuildId}/${mode}/fetched-source`;
}

/** The copy one `source_uri` job fetched and hash-checked itself; written only after the hash matched. */
export function jobSourceKey(jobId: string): string {
  return `${JOB_SOURCE_PREFIX}${jobId}/source`;
}

export const JOB_SOURCE_PREFIX = "staging/jobs/";

/** The job a {@link jobSourceKey} belongs to, or undefined for any other key. */
export function jobIdOfSourceKey(key: string): string | undefined {
  return /^staging\/jobs\/([0-9a-f-]{36})\/source$/.exec(key)?.[1];
}

/** Every staging copy of a rebuild's source, under both modes: a release must not depend on which one ran. */
export function stagedSourceKeys(rebuildId: string): string[] {
  return buildModes.flatMap((mode) => [fetchedSourceKey(rebuildId, mode), canonicalSourceKey(rebuildId, mode)]);
}

export function paramsDocumentKey(
  rebuildId: string,
  mode: BuildMode,
  container: "materialise" | "runner",
  dispatchNonce?: string,
): string {
  return `${dispatchPrefix(rebuildId, mode, dispatchNonce)}/params/${container}.json`;
}

// verification-svc serves a log only under the build-logs/ prefix.
export function buildLogKey(rebuildId: string, mode: BuildMode): string {
  return `build-logs/${rebuildId}/${mode}.log`;
}
