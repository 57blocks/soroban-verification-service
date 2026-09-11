// Key conventions mirror the path comments documented alongside each shape in ./shapes.ts (single source of
// truth for the storage layout).

export function reportKey(reportSha256: string): string {
  return joinKey("reports", `${reportSha256}.json`);
}

/** Written once per process by orchestrator-svc's `VerifierIdentityPublisher`, not per-publish. */
export function verifierPolicyKey(): string {
  return "policy.json";
}

/**
 * Written once per process by orchestrator-svc's `VerifierIdentityPublisher`, same as `verifierPolicyKey` above
 * — report-artifact plan.md phase 4.
 */
export function verifierManifestKey(): string {
  return "verifier-manifest.json";
}

/** wasms/{wasm_hash}.json — the Registry API's per-wasm status object. */
export function wasmStatusKey(wasmHash: string): string {
  return joinKey("wasms", `${wasmHash}.json`);
}

/**
 * Written by this package's `publishSource`, called from orchestrator-svc's `PublishService.writePublication`
 * only when the job's declared visibility is `public` (source-storage plan.md phase 4).
 */
export function sourceKey(sourceSha256: string, extension: string): string {
  return joinKey("sources", `${sourceSha256}${extension}`);
}

export function sourceKeyFromFileName(sourceFileName: string): string {
  return joinKey("sources", sourceFileName);
}

/**
 * The inverse split: recovers `extension` from a `{sha256}{extension}` file name given the `sha256` prefix —
 * e.g.
 */
export function sourceFileExtension(sourceFileName: string, sourceSha256: string): string {
  return sourceFileName.slice(sourceSha256.length);
}

/**
 * The other half, read out of the name instead of carried beside it: `sourceFileName` is `{sha256}{extension}`,
 * so the hash the published bytes are addressed by is its first 64 characters.
 */
export function sourceSha256FromFileName(sourceFileName: string): string {
  return sourceFileName.slice(0, 64);
}

function joinKey(...parts: string[]): string {
  return parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}
