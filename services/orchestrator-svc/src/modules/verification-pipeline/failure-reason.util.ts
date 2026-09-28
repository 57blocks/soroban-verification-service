import { classifyRebuildErrorCode, type FailureReason } from "@scvs/core";
import type { RebuildRecord } from "@scvs/db";
import { isConfigurationError } from "../../config/configuration-error.js";

export const MISCONFIGURED_REASON_CODE = "service_misconfigured";

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

export function rebuildFailureReason(rebuild: RebuildRecord): FailureReason {
  const diagnostics = (rebuild.diagnostics ?? {}) as {
    timed_out?: boolean;
    docker_error?: string;
  };
  if (diagnostics.timed_out) return "build_timeout";

  const failure = classifyRebuildErrorCode(rebuild.errorCode);
  if (failure === "source") return "source_unreachable";
  // Must precede the docker_error test below.
  if (failure === "policy") return "policy_rejected";
  if (failure === "infrastructure" || diagnostics.docker_error) {
    return "internal_error";
  }
  return "build_failed";
}

const GENERIC_REBUILD_FAILURE_DETAIL =
  "The sandbox rebuild could not be completed for this source and image.";

export function rebuildFailureDetail(rebuild: RebuildRecord): string {
  const diagnostics = (rebuild.diagnostics ?? {}) as {
    rejected_build_option?: string;
    rejected_build_option_origin?: string;
  };
  const flag = diagnostics.rejected_build_option;
  if (!flag) return GENERIC_REBUILD_FAILURE_DETAIL;

  return diagnostics.rejected_build_option_origin === "recorded_bldopt"
    ? `The build image's CLI does not accept the recorded build option \`${flag}\`, so this recipe cannot be replayed in it. ` +
        "The submitted source is not the problem: either that option was not part of the original build, or it needs a build image whose CLI supports it."
    : `The verifier added the build option \`${flag}\`, which this build image's CLI does not accept. ` +
        "This is a verifier fault, not a problem with the submission, and needs no change to the source or the recipe.";
}
