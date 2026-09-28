import type { BuildArchitecture, SourceReference } from "@scvs/core";
import type { JobRecord, RebuildRecord } from "@scvs/db";
import type { BuilderInvocationParams } from "./builder-invocation.util.js";

export function builderParams(
  rebuild: RebuildRecord,
  job: JobRecord,
  sourceRef: SourceReference,
  pinnedHash: string,
  environmentImage: { pullReference: string; arch?: BuildArchitecture }
): BuilderInvocationParams {
  const storedBuildOptions = parseRecipeBuildOptions(
    rebuild.buildOptions
  );
  return {
    rebuildId: rebuild.rebuildId,
    // The builder requires a pinned wasm_hash and refuses to fall back to --id.
    target: { ...job.target, wasm_hash: pinnedHash },
    sourceRef,
    imageDigest: environmentImage.pullReference,
    imageArchitecture: environmentImage.arch,
    ...(rebuild.chainSourceSha256
      ? { expectedSourceSha256: rebuild.chainSourceSha256 }
      : {}),
    buildOptions: storedBuildOptions.bldopt,
    buildArgs: storedBuildOptions.bldarg,
    metadataReplay: storedBuildOptions.metadata_replay,
  };
}

export function readRecipeBuildOptions(
  stored: unknown,
  metadataReplay?: string[]
): { bldarg?: string[]; bldopt?: string[]; metadata_replay?: string[] } {
  const parsed = parseRecipeBuildOptions(stored);
  return {
    ...parsed,
    ...(metadataReplay?.length ? { metadata_replay: metadataReplay } : {}),
  };
}

export function parseRecipeBuildOptions(stored: unknown): {
  bldarg?: string[];
  bldopt?: string[];
  metadata_replay?: string[];
} {
  if (!stored || typeof stored !== "object") {
    return {};
  }
  const value = stored as {
    bldarg?: unknown;
    bldopt?: unknown;
    metadata_replay?: unknown;
  };
  return {
    ...(Array.isArray(value.bldarg) &&
    value.bldarg.every((entry) => typeof entry === "string")
      ? { bldarg: value.bldarg }
      : {}),
    ...(Array.isArray(value.bldopt) &&
    value.bldopt.every((entry) => typeof entry === "string")
      ? { bldopt: value.bldopt }
      : {}),
    ...(Array.isArray(value.metadata_replay) &&
    value.metadata_replay.every((entry) => typeof entry === "string")
      ? { metadata_replay: value.metadata_replay }
      : {}),
  };
}
