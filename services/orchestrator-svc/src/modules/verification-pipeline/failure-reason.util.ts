import { classifyRebuildErrorCode, type FailureReason } from "@scvs/core";
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
 * First match wins, and the default `build_failed` is **not** retryable. The vocabulary and its classes live in
 * `@scvs/core`'s `rebuildErrorCodeClass`, which the sandbox writes against and this reads — a code with no
 * entry there cannot be emitted, and one added there without a class does not compile.
 */
export function rebuildFailureReason(rebuild: RebuildRecord): FailureReason {
  const diagnostics = (rebuild.diagnostics ?? {}) as {
    timed_out?: boolean;
    docker_error?: string;
  };
  if (diagnostics.timed_out) return "build_timeout";

  const failure = classifyRebuildErrorCode(rebuild.errorCode);
  if (failure === "source") return "source_unreachable";
  // Before the infrastructure rung: an inadmissible recipe is neither a source problem nor a machinery one, and
  // it must not be reachable by the `docker_error`-presence test below.
  if (failure === "policy") return "policy_rejected";
  // `build` and unknown codes both reach this test: a passed-through `docker_error` is machinery whatever the
  // code beside it says.
  if (failure === "infrastructure" || diagnostics.docker_error) {
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
