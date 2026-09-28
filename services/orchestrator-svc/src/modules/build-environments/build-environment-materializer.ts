import type {
  ComposeIntent,
  MaterializationResult,
  MaterializedEnvironment,
} from "@scvs/core";

/** Re-entrant and never blocking: materialize() reports whatever is true right now. */
export abstract class BuildEnvironmentMaterializer {
  abstract materialize(
    intent: ComposeIntent,
    correlationId: string,
  ): Promise<MaterializationResult>;

  abstract findReadyByRecipeSha256(
    recipeSha256: string,
  ): Promise<MaterializedEnvironment | undefined>;
}
