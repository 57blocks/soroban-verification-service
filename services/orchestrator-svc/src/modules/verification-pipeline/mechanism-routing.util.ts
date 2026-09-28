import { type BuildMode, evaluateBuildImage, type MechanismReason, type Sep58Metadata } from "@scvs/core";

export type MechanismRoutingInput = {
  chainRecipe: Pick<Sep58Metadata, "bldimg" | "bldarg" | "bldopt">;
  rebuildRecipe: { bldarg?: string[]; bldopt?: string[] };
  environmentIdentity: string;
};

export type MechanismRouting = {
  mode: BuildMode;
  reason: MechanismReason;
};

/** Every input maps to mode "build"; the branches only name why, which is published as recipe_source. */
export function selectBuildMechanism(input: MechanismRoutingInput): MechanismRouting {
  const chainImage = input.chainRecipe.bldimg;
  if (!chainImage) {
    return { mode: "build", reason: "no_chain_recorded_image" };
  }

  if (!evaluateBuildImage(chainImage).ok) {
    return { mode: "build", reason: "image_not_policy_accepted" };
  }

  if (input.environmentIdentity !== chainImage) {
    return { mode: "build", reason: "environment_is_composed" };
  }

  if (
    !sameList(input.rebuildRecipe.bldarg, input.chainRecipe.bldarg) ||
    !sameList(input.rebuildRecipe.bldopt, input.chainRecipe.bldopt)
  ) {
    return { mode: "build", reason: "recipe_deviates_from_chain" };
  }

  return { mode: "build", reason: "on_chain_recipe_in_trusted_image" };
}

function sameList(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}
