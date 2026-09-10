import type {
  ComposeIntent,
  MaterializationResult,
  MaterializedEnvironment,
} from "@scvs/core";

/**
 * **Re-entrant, never blocking.** `materialize()` is called on the orchestrator's preparing tick and returns
 * whatever is true right now.
 */
export abstract class BuildEnvironmentMaterializer {
  /** Find-or-start the environment for `intent`, and report its current state. */
  abstract materialize(
    intent: ComposeIntent,
    correlationId: string,
  ): Promise<MaterializationResult>;

  /**
   * Separate from `materialize()` because the caller is different and so is the failure meaning: this runs when
   * a `Rebuild` is already keyed on a published recipe hash and needs the pull coordinate to hand Batch.
   */
  abstract findReadyByRecipeSha256(
    recipeSha256: string,
  ): Promise<MaterializedEnvironment | undefined>;
}
