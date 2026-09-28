import type { BuildEnvironmentResolution, RecordedToolchainPair } from "@scvs/core";

export abstract class BuildEnvironmentResolver {
  abstract resolve(input: {
    sep58Image?: string;
    pair?: RecordedToolchainPair;
  }): Promise<BuildEnvironmentResolution>;
}
