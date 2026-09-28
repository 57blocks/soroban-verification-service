import { BUILD_ARTIFACT_SCHEMA_VERSION, BuildArtifact, parseDto, type BuildRecipe } from "@scvs/core";
import { assembleBuildLog } from "./build-log.js";
import { classifyRunCliOutcome, type RunCliResult } from "./run-cli.js";

export function buildRecipeArtifact(
  recipe: BuildRecipe,
  result: RunCliResult,
  rebuiltWasmUploaded = false,
): BuildArtifact {
  const buildLog = assembleBuildLog();
  const artifact = {
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
    ...(result.reason ? { reason: result.reason } : {}),
    ...(buildLog ? { build_log: buildLog } : {}),
    ...(compactFailureContext(result) ?? {}),
  };
  return parseDto(BuildArtifact, artifact);
}

const MAX_FAILURE_CONTEXT_BYTES = 8_192;

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
