import type { BuildEnvironmentResolution, RecordedToolchainPair } from "@scvs/core";

/**
 * Turns already chain-derived inputs into one of three outcomes: an existing chain-named image to trust as-is,
 * an addressable pair to eventually compose, or a reason the pair can never be served.
 */
export abstract class BuildEnvironmentResolver {
  abstract resolve(input: {
    /** Set only when the chain-injected `contractmetav0` section carries `bldimg` (cli-58). */
    sep58Image?: string;
    /** Set only when the section carries a recorded `(cliver, rsver)` with no `bldimg` (cli-legacy). */
    pair?: RecordedToolchainPair;
  }): Promise<BuildEnvironmentResolution>;
}
