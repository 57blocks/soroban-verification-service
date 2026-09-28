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

export async function readReport(storage: ResultStorage, reportSha256: string): Promise<VerificationArtifact | undefined> {
  return readAndParse(storage, reportKey(reportSha256), VerificationArtifact);
}

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

/** Falls back to `build_recipe.build_environment.trust_level` for reports published before `image_trust_level` existed. */
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
