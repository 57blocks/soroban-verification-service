import type { BuildArchitecture, SourceReference } from "@scvs/core";
import type { JobRecord, RebuildRecord } from "@scvs/db";
import type { BuilderInvocationParams } from "./builder-invocation.util.js";

/**
 * What a rebuild is dispatched with: the Batch payload, and the recorded build options that go into it.
 *
 * Pure, and out of the pipeline service for that reason — it reads a job, a rebuild and a recipe and returns a
 * payload, touching nothing else. Inside the service it was three private methods among twenty.
 */

export function builderParams(
  rebuild: RebuildRecord,
  job: JobRecord,
  sourceRef: SourceReference,
  pinnedHash: string,
  // Both halves of what `resolveImageReference` established, together: the pull coordinate the builder needs,
  // and.
  environmentImage: { pullReference: string; arch?: BuildArchitecture }
): BuilderInvocationParams {
  const storedBuildOptions = parseRecipeBuildOptions(
    rebuild.buildOptions
  );
  return {
    rebuildId: rebuild.rebuildId,
    // Carries the resolved hash, not the bare persisted target: `services/builder`'s verify path requires a
    // pinned `wasm_hash` and refuses to fall back to `--id`, and a "submitted"-mode job may have been created
    // from a target that only had a contract_id.
    target: { ...job.target, wasm_hash: pinnedHash },
    sourceRef,
    // The resolved pull reference: for cli-legacy the environment is the verifier's own composed one.
    imageDigest: environmentImage.pullReference,
    // Present only for a composed environment that recorded it.
    imageArchitecture: environmentImage.arch,
    // `mainnetRpcUrl` stays configured — `ChainReaderService` reads the chain with it on this same service.
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

/**
 * The job's target as log *fields*. `job_id` is deliberately absent: `BuildDispatchScheduler` entered the
 * ambient scope with it before calling in, so every record here already carries it (O2).
 */
/** O4's "job duration by path and outcome". */
