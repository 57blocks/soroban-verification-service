import type { BuildMode, MechanismReason, Sep58Metadata } from "@scvs/core";
import { evaluateBuildImage } from "./policy.js";

/**
 * The provenance question "is this the chain's own recipe?" is unchanged and still answered here; only its
 * consequence for the mechanism is gone.
 */
export type MechanismRoutingInput = {
  /** The chain-recorded build recipe, as parsed from the deployed Wasm's `contractmetav0` section. */
  chainRecipe: Pick<Sep58Metadata, "bldimg" | "bldarg" | "bldopt">;
  /** What this rebuild will actually be asked to build with. */
  rebuildRecipe: { bldarg?: string[]; bldopt?: string[] };
  environmentIdentity: string;
};

export type MechanismRouting = {
  mode: BuildMode;
  /** One value, not a sentence. */
  reason: MechanismReason;
};

/**
 * Pure and total. Every input maps to `mode: "build"`; the branches exist to name **why**, because that value
 * outlives the routing decision as `recipe_source`.
 */
export function selectBuildMechanism(input: MechanismRoutingInput): MechanismRouting {
  const chainImage = input.chainRecipe.bldimg;
  if (!chainImage) {
    // cli-legacy, or a contract carrying no build metadata at all.
    return { mode: "build", reason: "no_chain_recorded_image" };
  }

  // Belt and braces: `resolveEnvironmentIdentity` already fails a job whose chain-named image policy rejects,
  // so this is unreachable through that path.
  if (!evaluateBuildImage(chainImage).ok) {
    return { mode: "build", reason: "image_not_policy_accepted" };
  }

  // A composed environment is this verifier's own image, not the one the chain named — so the CLI would be
  // verifying against something the contract never recorded.
  if (input.environmentIdentity !== chainImage) {
    return { mode: "build", reason: "environment_is_composed" };
  }

  // The recipe must be the chain's, field for field.
  if (
    !sameList(input.rebuildRecipe.bldarg, input.chainRecipe.bldarg) ||
    !sameList(input.rebuildRecipe.bldopt, input.chainRecipe.bldopt)
  ) {
    return { mode: "build", reason: "recipe_deviates_from_chain" };
  }

  // The recipe is the chain's own, replayed in the image the chain named.
  return { mode: "build", reason: "on_chain_recipe_in_trusted_image" };
}

/** Absent and empty are the same recipe — one is how the chain omits a key, the other how we store it. */
function sameList(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

// `earnsBuildModeRetry` stood here: whether a terminal `cli_failure` earned the one verify→build demotion.
