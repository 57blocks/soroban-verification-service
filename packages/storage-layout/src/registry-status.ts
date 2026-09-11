import {
  isSameVerifier,
  parseStrictRegistryStatusObject,
  REGISTRY_SCHEMA,
  REGISTRY_SCHEMA_VERSION,
  safeParseDto,
  toResultUrl,
  upgradeLegacyEntry,
  PeerRegistryStatusObject,
  type ImageTrustLevel,
  type LegacyCustody,
  type PeerRegistryVerification,
  type RecipeSource,
  type RegistryResultUrl,
  type RegistrySourceCodeUri,
  type RegistryStatusObject,
  type RegistryVerification,
  type RegistryVerifier,
} from "@scvs/core";

// The wire shape lives in packages/core/src/registry.ts; this file owns the merge rule and the write-side
// strictness.

export type BuildWasmStatusParams = {
  existing: PeerRegistryStatusObject | undefined;
  wasmHash: string;
  /** `url` is the result root — the identity `isSameVerifier` keys on (AU2). */
  verifier: RegistryVerifier & { url: string };
  verdict: "verified" | "mismatched";
  recipeSource: RecipeSource;
  imageTrustLevel: ImageTrustLevel;
  bldimg?: string;
  /** SEP-58 v0.6.0: order-significant; passed through as recorded. */
  bldarg?: string[];
  /** An array of complete flags; order is not significant. */
  bldopt?: string[];
  sourceSha256: string;
  sourceUri?: string;
  /** Required when verdict === "mismatched"; the strict parse rejects an entry missing it. */
  rebuiltHash?: string;
  processedAt: string;
  /** Every entry must carry `sha256` — AU1: we publish nothing we cannot anchor. */
  resultsUrls: RegistryResultUrl[];
  verifiedSourceCodeUris?: RegistrySourceCodeUri[];
};

/** This verifier's own entry in a document, by identity, or undefined when it has none. */
export function findOwnEntry(
  document: PeerRegistryStatusObject | undefined,
  verifier: RegistryVerifier,
): PeerRegistryVerification | undefined {
  const entries = document?.source_code_verifications ?? [];
  const byIdentity = entries.find((entry) => isSameVerifier(entry.verifier, verifier));
  if (byIdentity || !verifier.url) return byIdentity;
  const root = `${verifier.url.replace(/\/+$/, "")}/`;
  return entries.find(
    (entry) =>
      entry.verifier.url === undefined &&
      (entry.results_urls ?? []).some((link) => toResultUrl(link).url.startsWith(root)),
  );
}

/** Computes the status object for one verification. */
export function buildWasmStatus(params: BuildWasmStatusParams): RegistryStatusObject {
  const entries = params.existing?.source_code_verifications ?? [];
  const ours = findOwnEntry(params.existing, params.verifier);

  if (ours?.status === "verified" && params.verdict === "mismatched") {
    return params.existing as unknown as RegistryStatusObject;
  }

  if (params.verdict === "mismatched" && !params.rebuiltHash) {
    throw new Error("buildWasmStatus: rebuiltHash is required when verdict is 'mismatched'");
  }
  const unanchored = params.resultsUrls.find((entry) => !entry.sha256);
  if (unanchored) {
    throw new Error(`buildWasmStatus: results_urls entry ${unanchored.url} has no sha256 (AU1)`);
  }

  const next: RegistryVerification = {
    verifier: { name: params.verifier.name, url: params.verifier.url },
    status: params.verdict,
    recipe_source: params.recipeSource,
    image_trust_level: params.imageTrustLevel,
    ...(params.bldimg ? { bldimg: params.bldimg } : {}),
    ...(params.bldarg ? { bldarg: params.bldarg } : {}),
    ...(params.bldopt ? { bldopt: params.bldopt } : {}),
    source_sha256: params.sourceSha256,
    ...(params.sourceUri ? { source_uri: params.sourceUri } : {}),
    ...(params.verdict === "mismatched" ? { rebuilt_hash: params.rebuiltHash } : {}),
    processed_at: params.processedAt,
    results_urls: params.resultsUrls,
    ...(params.verifiedSourceCodeUris ? { verified_source_code_uris: params.verifiedSourceCodeUris } : {}),
  };

  const others = entries.filter((entry) => entry !== ours).map((entry) => upgradeOrThrow(entry, undefined));

  return parseStrictRegistryStatusObject({
    schema: REGISTRY_SCHEMA,
    schema_version: REGISTRY_SCHEMA_VERSION,
    wasm_hash: params.wasmHash,
    updated_at: params.processedAt,
    source_code_verifications: [...others, next],
  } satisfies RegistryStatusObject);
}

/** Re-emit a document read in either shape as a strict SEP document, with one entry replaced. */
export function rewriteWasmStatus(
  existing: PeerRegistryStatusObject,
  replaceIndex: number,
  replacement: RegistryVerification,
  updatedAt: string,
): RegistryStatusObject | undefined {
  const entries: RegistryVerification[] = [];
  for (const [index, entry] of existing.source_code_verifications.entries()) {
    if (index === replaceIndex) {
      entries.push(replacement);
      continue;
    }
    const upgraded = upgradeLegacyEntry(entry, undefined);
    if (!upgraded) return undefined;
    entries.push(upgraded);
  }
  const document = {
    schema: REGISTRY_SCHEMA,
    schema_version: REGISTRY_SCHEMA_VERSION,
    wasm_hash: existing.wasm_hash,
    updated_at: updatedAt,
    source_code_verifications: entries,
  } satisfies RegistryStatusObject;
  try {
    return parseStrictRegistryStatusObject(document);
  } catch {
    // The upgrade guards are the first line and this is the second.
    return undefined;
  }
}

function upgradeOrThrow(entry: PeerRegistryVerification, custody: LegacyCustody | undefined): RegistryVerification {
  const upgraded = upgradeLegacyEntry(entry, custody);
  if (!upgraded) {
    throw new Error(
      `buildWasmStatus: entry for verifier ${entry.verifier.url ?? entry.verifier.name} cannot be carried into the SEP shape`,
    );
  }
  return upgraded;
}

/**
 * Validates one of OUR documents strictly — `additionalProperties: false` at every level, exactly the shape and
 * version we claim (CV1).
 */
export function validateWasmStatus(value: unknown): RegistryStatusObject {
  return parseStrictRegistryStatusObject(value);
}

/** Non-throwing counterpart of validateWasmStatus. */
export function safeValidateWasmStatus(
  value: unknown,
): { success: true; data: RegistryStatusObject } | { success: false } {
  try {
    return { success: true, data: validateWasmStatus(value) };
  } catch {
    return { success: false };
  }
}

/** Unknown fields survive (CV8). */
export function parsePeerWasmStatus(value: unknown): PeerRegistryStatusObject | undefined {
  const result = safeParseDto(PeerRegistryStatusObject, value);
  return result.success ? result.data : undefined;
}
