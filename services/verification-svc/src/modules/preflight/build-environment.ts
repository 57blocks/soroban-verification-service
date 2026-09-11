import {
  classifyBuildEnvironment,
  type BuildEnvironmentResolution,
  type RecordedToolchainPair,
  type Sep58Metadata,
} from "@scvs/core";
import { evaluateBuildImage } from "./policy.js";

/** `BuildEnvironmentResolution` plus the two diagnostics that only make sense at preflight time: */
export type PreflightBuildEnvironment =
  | BuildEnvironmentResolution
  | { kind: "chain_named_policy_rejected"; reason: string; detail: string };

/**
 * Pair extraction is already complete here. The chain reader derives it independently from every metadata
 * section because SDK `rsver` and CLI `cliver` normally have different provenance.
 */
export function classifyPreflightBuildEnvironment(
  sep58: Sep58Metadata,
  pair: RecordedToolchainPair | undefined,
): PreflightBuildEnvironment {
  if (sep58.bldimg) {
    const imagePolicy = evaluateBuildImage(sep58.bldimg);
    if (!imagePolicy.ok) {
      return {
        kind: "chain_named_policy_rejected",
        reason: imagePolicy.reason,
        detail: imagePolicy.detail,
      };
    }
    return classifyBuildEnvironment({ policyCheckedImage: imagePolicy.image });
  }

  return classifyBuildEnvironment({ pair });
}
