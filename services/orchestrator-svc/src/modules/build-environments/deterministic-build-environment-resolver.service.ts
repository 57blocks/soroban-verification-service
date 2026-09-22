import { Injectable } from "@nestjs/common";
import {
  type BuildEnvironmentResolution,
  classifyBuildEnvironment,
  CURRENT_COMPOSE_TEMPLATE_VERSION,
  evaluateBuildImage,
  type RecordedToolchainPair,
} from "@scvs/core";
import { BuildEnvironmentResolver } from "./build-environment-resolver.js";

export { CURRENT_COMPOSE_TEMPLATE_VERSION };

/** Thrown when `resolve()` is called with a `sep58Image` that fails image policy. */
export class BuildEnvironmentResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildEnvironmentResolutionError";
  }
}

/**
 * No network call, no database read, no submitter-reachable input — the property that makes it safe to run on
 * every preparing tick.
 */
@Injectable()
export class DeterministicBuildEnvironmentResolver extends BuildEnvironmentResolver {
  async resolve(input: {
    sep58Image?: string;
    pair?: RecordedToolchainPair;
  }): Promise<BuildEnvironmentResolution> {
    if (input.sep58Image !== undefined) {
      const imagePolicy = evaluateBuildImage(input.sep58Image);
      if (!imagePolicy.ok) {
        throw new BuildEnvironmentResolutionError(
          `A chain-injected bldimg failed image policy (${imagePolicy.reason}): ${imagePolicy.detail} ` +
            "Callers must not ask this resolver about a sep58Image that has not already cleared " +
            "evaluateBuildImage() — a rejection here is not one of this resolver's three outcomes.",
        );
      }
      return classifyBuildEnvironment({ policyCheckedImage: imagePolicy.image });
    }

    return classifyBuildEnvironment({ pair: input.pair });
  }
}
