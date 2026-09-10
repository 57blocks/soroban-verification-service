import type { FailureReason } from "@scvs/core";
import type { RebuildRecord } from "@scvs/db";
import { isConfigurationError } from "../../config/configuration-error.js";

/** The reason code every missing-configuration failure is recorded under. */
export const MISCONFIGURED_REASON_CODE = "service_misconfigured";

/** How a missing environment variable is recorded — or `undefined` when this is not one. */
export function configurationFailure(
  error: unknown,
): { reason: FailureReason; reasonCode: string; envName: string; detail: string } | undefined {
  if (!isConfigurationError(error)) return undefined;
  return {
    reason: "build_failed",
    reasonCode: MISCONFIGURED_REASON_CODE,
    envName: error.envName,
    detail: error.message,
  };
}

/**
 * Source-side codes `services/builder` emits when it could not get the bytes it was asked to build, or could
 * not trust them.
 */
const SOURCE_CODES: ReadonlySet<string> = new Set([
  "source_archive_extract_failed",
  "source_archive_layout_invalid",
  // Both are source codes and both are permanent, which is the honest classification: the submitter
  // recompressed a source archive (a `.tar.gz.zip`), we unwrapped one level, and what was inside is either not
  // an archive we read or is another wrapper.
  "source_archive_nested_too_deep",
  "source_archive_nested_unsupported",
  // The materialiser refuses an archive that is not the `source_sha256` the deployed Wasm records, at the one
  // point the bytes are in hand.
  "source_archive_not_chain_recorded",
  "source_archive_too_large",
  "source_archive_too_large_uncompressed",
  "source_archive_too_many_entries",
  "source_archive_unreadable",
  "source_archive_unsafe_link",
  "source_archive_unsafe_path",
  "source_archive_unsupported_entry",
  "source_hash_mismatch",
  "source_not_extracted",
  "source_path_not_found",
  "source_ref_unsupported",
  "source_stage_copy_failed",
  "source_uri_missing",
  "source_uri_not_materialized",
  // Emitted on both sides of the boundary now: `orchestrator-svc` records it when the destination policy
  // refuses a submitter's `source_uri` before dispatch, and the sandbox records it if it is ever handed a URL
  // that is not a presigned staging location.
  "source_uri_refused",
  // This set classifies a code read off a *persisted* row, so pruning it can only turn an old row's clean
  // `source_unreachable` into a fall-through.
  "git_clone_failed",
  "git_checkout_failed",
]);

/**
 * Codes where the *recorded recipe itself* is inadmissible — the verifier refuses to replay it, rather than
 * trying and failing.
 */
const POLICY_CODES: ReadonlySet<string> = new Set([
  "absolute_manifest_path_not_supported",
  "manifest_path_escapes_source",
  // Retryability does not change — both are permanent.
  "recorded_build_option_unsupported",
]);

/** Codes that mean the *machinery* failed rather than the recipe. */
const INFRASTRUCTURE_CODES: ReadonlySet<string> = new Set([
  "sandbox_unavailable",
  // The toolchain probe is the first command to touch the build image, so on a cold host it pays for the pull.
  "toolchain_probe_failed",
  "batch_job_failed_no_artifact",
  // The mirror of `recorded_build_option_unsupported`: an argument *we* added that the image rejects means
  // BE11's probe (`argument-policy.ts:resolveAddedArguments`) did not cover it.
  "added_build_option_unsupported",
  // Reads `source_archive_*` and is deliberately **not** a source code: the archive is fine, the builder image
  // is missing the binary that reads it (`bsdtar`, for zip).
  "source_archive_reader_unavailable",
]);

/** First match wins, and the default `build_failed` is **not** retryable. */
export function rebuildFailureReason(rebuild: RebuildRecord): FailureReason {
  const diagnostics = (rebuild.diagnostics ?? {}) as {
    timed_out?: boolean;
    docker_error?: string;
  };
  if (diagnostics.timed_out) return "build_timeout";

  const code = rebuild.errorCode;
  if (code && SOURCE_CODES.has(code)) return "source_unreachable";
  // Before the infrastructure rung: an inadmissible recipe is neither a source problem nor a machinery one, and
  // it must not be reachable by the `docker_error`-presence test below.
  if (code && POLICY_CODES.has(code)) return "policy_rejected";
  if ((code && INFRASTRUCTURE_CODES.has(code)) || diagnostics.docker_error) {
    return "internal_error";
  }
  return "build_failed";
}

/** The generic sentence a failed rebuild reports when nothing more specific is known. */
const GENERIC_REBUILD_FAILURE_DETAIL =
  "The sandbox rebuild could not be completed for this source and image.";

/**
 * What the submitter is told about a failed rebuild. Beside `rebuildFailureReason` deliberately: the reason and
 * the sentence explaining it are read together and must not drift.
 */
export function rebuildFailureDetail(rebuild: RebuildRecord): string {
  const diagnostics = (rebuild.diagnostics ?? {}) as {
    rejected_build_option?: string;
    rejected_build_option_origin?: string;
  };
  const flag = diagnostics.rejected_build_option;
  if (!flag) return GENERIC_REBUILD_FAILURE_DETAIL;

  // Two audiences, two sentences. A submitter can act on the first and cannot act on the second, so telling
  // them to check their recipe when the fault is ours would be worse than saying nothing.
  return diagnostics.rejected_build_option_origin === "recorded_bldopt"
    ? `The build image's CLI does not accept the recorded build option \`${flag}\`, so this recipe cannot be replayed in it. ` +
        "The submitted source is not the problem: either that option was not part of the original build, or it needs a build image whose CLI supports it."
    : `The verifier added the build option \`${flag}\`, which this build image's CLI does not accept. ` +
        "This is a verifier fault, not a problem with the submission, and needs no change to the source or the recipe.";
}
