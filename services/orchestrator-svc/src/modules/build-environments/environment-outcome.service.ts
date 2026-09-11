import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createS3Client, getObjectText } from "@scvs/aws";
import { EnvironmentsRepository, type EnvironmentRecord } from "@scvs/db";
import {
  ComposerArtifact as ComposerArtifactDto,
  ScvsLogger,
  ScvsMetrics,
  composedEnvironmentRecipeHash,
  isBuildArchitecture,
  parseDto,
  type ComposerArtifact,
} from "@scvs/core";
import { composerArtifactKey } from "./composer-dispatch.service.js";
import type { AppConfigService } from "../../config/configuration.js";

/** What this service decided about a composition, after verifying the composer's own receipt. */
export type EnvironmentOutcome =
  | { status: "ready"; recipeSha256: string; imageDigest: string }
  | { status: "failed"; errorCode: string };

/** The one place that turns "the composer's `composer.json`" into "this environment's recorded state". */
@Injectable()
export class EnvironmentOutcomeService {
  private readonly logger = new ScvsLogger("environment-outcome");
  private readonly metrics = new ScvsMetrics("environment-outcome", { logger: this.logger });

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(EnvironmentsRepository) private readonly environments: EnvironmentsRepository,
  ) {}

  /** Records the outcome for a composition whose Batch job is known to have reached a terminal state. */
  async recordFromBatchTerminalState(
    environment: EnvironmentRecord,
    event: { status: string; statusReason?: string },
  ): Promise<EnvironmentOutcome> {
    const artifact = await this.readArtifact(environment);
    if (!artifact) {
      const { bucket } = this.configService.get("stagingStorage", { infer: true });
      this.logger.warn("no composer receipt found; recording a failure from the Batch event", {
        environment_id: environment.environmentId,
        staging_bucket: bucket,
        artifact_key: composerArtifactKey(environment.environmentId),
        batch_status: event.status,
        status_reason: event.statusReason,
      });
      return this.recordFailure(environment, "composer_finished_without_receipt");
    }
    return this.record(environment, artifact);
  }

  /** Records the outcome **only** if the composer's receipt is there to read, and reports whether it was. */
  async tryRecordFromArtifact(environment: EnvironmentRecord): Promise<boolean> {
    const artifact = await this.readArtifact(environment);
    if (!artifact) return false;
    await this.record(environment, artifact);
    return true;
  }

  private async readArtifact(
    environment: EnvironmentRecord,
  ): Promise<ComposerArtifact | undefined> {
    const staging = this.configService.get("stagingStorage", { infer: true });
    const s3 = createS3Client({ region: staging.region });
    const raw = await getObjectText(
      s3,
      staging.bucket,
      composerArtifactKey(environment.environmentId),
    );
    // A *failure to read* (permissions, an unreachable bucket) still throws — that is not the same fact as "no
    // receipt" and must not be recorded as one.
    if (!raw) return undefined;
    return parseDto(ComposerArtifactDto, JSON.parse(raw));
  }

  /** Verifies the receipt, then writes the row. */
  private async record(
    environment: EnvironmentRecord,
    artifact: ComposerArtifact,
  ): Promise<EnvironmentOutcome> {
    if (artifact.environment_id !== environment.environmentId) {
      // A receipt for a different environment at this environment's key.
      this.logger.error("composer receipt is for a different environment", {
        environment_id: environment.environmentId,
        receipt_environment_id: artifact.environment_id,
      });
      return this.recordFailure(environment, "composer_receipt_mismatched_environment");
    }

    if (artifact.classification === "composition_failure") {
      this.logger.warn("composer reported a composition failure", {
        environment_id: environment.environmentId,
        cliver: environment.cliver,
        rsver: environment.rsver,
        reason: artifact.reason,
        // Keys only, matching `RebuildOutcomeService`'s treatment of `failure_context`: the values travel on
        // the receipt, which is the channel meant to carry them.
        failure_context_keys: artifact.failure_context
          ? Object.keys(artifact.failure_context).sort()
          : undefined,
      });
      return this.recordFailure(environment, artifact.reason || "composition_failed");
    }

    const invalid = this.verifySuccessReceipt(environment, artifact);
    if (invalid) return this.recordFailure(environment, invalid);

    // Non-null by `verifySuccessReceipt` above.
    const recipeSha256 = artifact.recipe_sha256!;
    const imageDigest = artifact.image_digest!;
    const recipe = artifact.recipe!;

    await this.environments.markReady(environment.environmentId, {
      recipeSha256,
      imageDigest,
      recipe,
      // See `ComposerArtifact.image_architecture` for why `@IsIn` there was wrong: it would have thrown out of
      // `readArtifact`, leaving the pair to be recomposed forever.
      ...(isBuildArchitecture(artifact.image_architecture)
        ? { arch: artifact.image_architecture }
        : {}),
    });
    this.recordDuration(environment, "success");
    this.metrics.counter("environment_composition_total", 1, {
      outcome: "success",
      template_version: environment.templateVersion,
    });
    this.logger.log("environment composed and ready", {
      environment_id: environment.environmentId,
      cliver: environment.cliver,
      rsver: environment.rsver,
      template_version: environment.templateVersion,
      recipe_sha256: recipeSha256,
      image_digest: imageDigest,
      // Absent here means every rebuild against this environment will route by the configured default rather
      // than by what the image declares — worth seeing at the moment the row becomes usable.
      image_architecture: artifact.image_architecture,
      reported_cliver: artifact.smoke_test?.reported_cliver,
      reported_rsver: artifact.smoke_test?.reported_rsver,
    });
    return { status: "ready", recipeSha256, imageDigest };
  }

  /** Returns an error code when a `success` receipt cannot be trusted, or `undefined` when it can. */
  private verifySuccessReceipt(
    environment: EnvironmentRecord,
    artifact: ComposerArtifact,
  ): string | undefined {
    if (!artifact.recipe_sha256 || !artifact.image_digest || !artifact.recipe) {
      // The three identities are not independently optional: a row with a recipe hash but no pull coordinate is
      // not a coherent `ready` state (`EnvironmentsRepository.markReady` requires all three), so half-recording
      // this would produce an environment nothing could dispatch against.
      this.logger.error("composer reported success without all three identities", {
        environment_id: environment.environmentId,
        has_recipe_sha256: artifact.recipe_sha256 !== undefined,
        has_image_digest: artifact.image_digest !== undefined,
        has_recipe: artifact.recipe !== undefined,
      });
      return "composer_receipt_incomplete";
    }

    if (
      artifact.recipe.pair.cliver !== environment.cliver ||
      artifact.recipe.pair.rsver !== environment.rsver ||
      artifact.recipe.template_version !== environment.templateVersion
    ) {
      // The composer built something other than what it was asked for.
      this.logger.error("composer receipt describes a different pair or template than requested", {
        environment_id: environment.environmentId,
        requested_cliver: environment.cliver,
        requested_rsver: environment.rsver,
        requested_template_version: environment.templateVersion,
        received_cliver: artifact.recipe.pair.cliver,
        received_rsver: artifact.recipe.pair.rsver,
        received_template_version: artifact.recipe.template_version,
      });
      return "composer_receipt_wrong_pair";
    }

    const recomputed = composedEnvironmentRecipeHash(artifact.recipe);
    if (recomputed !== artifact.recipe_sha256) {
      // The published identity would not hash from the published recipe.
      this.logger.error("composer receipt's recipe_sha256 does not hash from its own recipe", {
        environment_id: environment.environmentId,
        reported_recipe_sha256: artifact.recipe_sha256,
        recomputed_recipe_sha256: recomputed,
      });
      return "composer_recipe_hash_mismatch";
    }

    if (artifact.smoke_test && !artifact.smoke_test.matches_pair) {
      this.logger.error("composer reported success with a failed smoke test", {
        environment_id: environment.environmentId,
        reported_cliver: artifact.smoke_test.reported_cliver,
        reported_rsver: artifact.smoke_test.reported_rsver,
      });
      return "composer_smoke_test_disagreed";
    }

    return undefined;
  }

  private async recordFailure(
    environment: EnvironmentRecord,
    errorCode: string,
  ): Promise<EnvironmentOutcome> {
    await this.environments.markFailed(environment.environmentId, errorCode);
    this.recordDuration(environment, "composition_failure");
    this.metrics.counter("environment_composition_total", 1, {
      outcome: "composition_failure",
      template_version: environment.templateVersion,
    });
    return { status: "failed", errorCode };
  }

  /**
   * Dispatch-to-terminal wall clock. Measured from `createdAt` rather than from the claim: the row is created
   * and claimed within the same tick, and `updatedAt` has already moved by the time this runs.
   */
  private recordDuration(environment: EnvironmentRecord, outcome: string): void {
    const seconds = (Date.now() - Date.parse(environment.createdAt)) / 1000;
    this.metrics.histogram("environment_composition_seconds", seconds, {
      outcome,
      template_version: environment.templateVersion,
    });
  }
}
