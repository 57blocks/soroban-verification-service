export function reportKey(reportSha256: string): string {
  return joinKey("reports", `${reportSha256}.json`);
}

export function verifierPolicyKey(): string {
  return "policy.json";
}

export function verifierManifestKey(): string {
  return "verifier-manifest.json";
}

export function wasmStatusKey(wasmHash: string): string {
  return joinKey("wasms", `${wasmHash}.json`);
}

export function sourceKey(sourceSha256: string, extension: string): string {
  return joinKey("sources", `${sourceSha256}${extension}`);
}

export function sourceKeyFromFileName(sourceFileName: string): string {
  return joinKey("sources", sourceFileName);
}

export function sourceFileExtension(sourceFileName: string, sourceSha256: string): string {
  return sourceFileName.slice(sourceSha256.length);
}

/** `sourceFileName` is `{sha256}{extension}`; the hex sha256 is its first 64 characters. */
export function sourceSha256FromFileName(sourceFileName: string): string {
  return sourceFileName.slice(0, 64);
}

function joinKey(...parts: string[]): string {
  return parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}
