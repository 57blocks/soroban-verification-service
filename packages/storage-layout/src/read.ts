import {
  IMAGE_TRUST_LEVELS,
  safeParseDto,
  type ClassConstructor,
  type LegacyCustody,
  type PeerRegistryStatusObject,
} from "@scvs/core";
import { VerificationArtifact } from "./shapes.js";
import { reportKey, wasmStatusKey } from "./keys.js";
import { parsePeerWasmStatus } from "./registry-status.js";
import type { ResultStorage } from "./storage-backend.js";

/**
 * Read-side lookups used by services/query-svc (cross-verifier aggregation) and, for a verifier's own results,
 * possibly clients/sdk.
 */
export async function readReport(storage: ResultStorage, reportSha256: string): Promise<VerificationArtifact | undefined> {
  return readAndParse(storage, reportKey(reportSha256), VerificationArtifact);
}

/**
 * Reads wasms/{wasm_hash}.json — the `existing` a caller passes to `buildWasmStatus` so it can apply the merge
 * rule, and the document the append-style writers in publish.ts rewrite.
 */
export async function readWasmStatus(storage: ResultStorage, wasmHash: string): Promise<PeerRegistryStatusObject | undefined> {
  const text = await storage.readText(wasmStatusKey(wasmHash));
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return parsePeerWasmStatus(parsed);
}

/**
 * What an entry written under the Registry API draft cannot carry itself and the append-style writers need to
 * upgrade it: the trust level. The artifact's own top-level `image_trust_level` is the primary source; a report
 * published before that field existed still only carries it nested under `build_recipe.build_environment.trust_level`,
 * so that path stays as the fallback for as long as such a report can still be read.
 */
export async function readLegacyCustody(storage: ResultStorage, reportSha256: string): Promise<LegacyCustody | undefined> {
  const report = await readReport(storage, reportSha256);
  if (report?.image_trust_level !== undefined) {
    return { imageTrustLevel: report.image_trust_level };
  }
  const environment = (report?.build_recipe as Record<string, unknown> | undefined)?.build_environment as
    | Record<string, unknown>
    | undefined;
  const level = environment?.trust_level;
  return (IMAGE_TRUST_LEVELS as readonly string[]).includes(level as string)
    ? { imageTrustLevel: level as LegacyCustody["imageTrustLevel"] }
    : undefined;
}

async function readAndParse<T extends object>(
  storage: ResultStorage,
  path: string,
  cls: ClassConstructor<T>,
): Promise<T | undefined> {
  const text = await storage.readText(path);
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = safeParseDto(cls, parsed);
  return result.success ? result.data : undefined;
}
