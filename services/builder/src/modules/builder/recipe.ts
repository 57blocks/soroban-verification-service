import { BUILD_ARTIFACT_SCHEMA_VERSION, BuildArtifact, parseDto, type BuildRecipe } from "@scvs/core";
import { assembleBuildLog } from "./build-log.js";
import { classifyRunCliOutcome, type RunCliResult } from "./run-cli.js";

/**
 * Assembles `recipe.json` — the self-describing build artifact services/orchestrator-svc/src/publish (build-
 * result.ts, and for the "build" fallback path, compare.ts) consumes.
 */
export function buildRecipeArtifact(
  recipe: BuildRecipe,
  result: RunCliResult,
  /** Whether the rebuilt bytes made it to their own presigned target. */
  rebuiltWasmUploaded = false,
): BuildArtifact {
  const buildLog = assembleBuildLog();
  const artifact = {
    // First field, and unconditional: every artifact this function returns declares its shape, which is what
    // lets a reader that predates the shape fail with a reason instead of a validation error.
    schema_version: BUILD_ARTIFACT_SCHEMA_VERSION,
    recipe,
    runner: result.runner,
    built_at: new Date().toISOString(),
    exit_code: result.exit_code,
    classification: classifyRunCliOutcome(result.outcome),
    ...(rebuiltWasmUploaded ? { rebuilt_wasm_uploaded: true } : {}),
    ...(result.rebuilt_wasm_hash ? { rebuilt_wasm_hash: result.rebuilt_wasm_hash } : {}),
    ...(result.rebuilt_wasm_size_bytes !== undefined
      ? { rebuilt_wasm_size_bytes: result.rebuilt_wasm_size_bytes }
      : {}),
    ...(result.source_sha256 ? { source_sha256: result.source_sha256 } : {}),
    ...(result.source_canonicalisation
      ? { source_canonicalisation: result.source_canonicalisation }
      : {}),
    ...(result.verify_attempt_reason
      ? { verify_attempt_reason: result.verify_attempt_reason }
      : {}),
    ...(result.sandbox_diagnostics ? { diagnostics: result.sandbox_diagnostics } : {}),
    // Several fallback-path failures return a precise reason and no schema-conformant diagnostics, and this
    // file is the only channel out of the sandbox.
    ...(result.reason ? { reason: result.reason } : {}),
    // Assembled here rather than passed in, because every caller of this function is a terminal path and every
    // terminal path owes a log.
    ...(buildLog ? { build_log: buildLog } : {}),
    ...(compactFailureContext(result) ?? {}),
  };
  return parseDto(BuildArtifact, artifact);
}

/**
 * Serialized-size ceiling for `failure_context`. Beyond this the context is dropped, not truncated: half a JSON
 * object is worse than none, and `diagnostics` is where bulk legitimately belongs.
 */
const MAX_FAILURE_CONTEXT_BYTES = 8_192;

/**
 * `result.diagnostics` is documented as rich and unstructured — on some paths it embeds whole `CommandResult`s
 * (a prefetch's full stdout/stderr, a `docker ps` probe).
 */
function compactFailureContext(
  result: RunCliResult,
): { failure_context: Record<string, unknown> } | undefined {
  if (result.outcome !== "cli_failure") return undefined;
  const context = result.diagnostics;
  if (!context || Object.keys(context).length === 0) return undefined;
  const serialized = JSON.stringify(context);
  if (serialized === undefined || serialized.length > MAX_FAILURE_CONTEXT_BYTES) {
    return { failure_context: { omitted: "too_large", reason: result.reason ?? "cli_failure" } };
  }
  return { failure_context: context };
}
