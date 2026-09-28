import {
  type BuildEnvironmentResolution,
  classifyBuildEnvironment,
  evaluateBuildImage,
  type RecordedToolchainPair,
  type Sep58Metadata,
} from "@scvs/core";

export type PreflightBuildEnvironment =
  | BuildEnvironmentResolution
  | { kind: "chain_named_policy_rejected"; reason: string; detail: string };

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
