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

export type EnvironmentOutcome =
  | { status: "ready"; recipeSha256: string; imageDigest: string }
  | { status: "failed"; errorCode: string };

@Injectable()
export class EnvironmentOutcomeService {
  private readonly logger = new ScvsLogger("environment-outcome");
  private readonly metrics = new ScvsMetrics("environment-outcome", { logger: this.logger });

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(EnvironmentsRepository) private readonly environments: EnvironmentsRepository,
  ) {}

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
    // A read failure throws rather than returning undefined: it is not "no receipt".
    if (!raw) return undefined;
    return parseDto(ComposerArtifactDto, JSON.parse(raw));
  }

  private async record(
    environment: EnvironmentRecord,
    artifact: ComposerArtifact,
  ): Promise<EnvironmentOutcome> {
    if (artifact.environment_id !== environment.environmentId) {
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
        failure_context_keys: artifact.failure_context
          ? Object.keys(artifact.failure_context).sort()
          : undefined,
      });
      return this.recordFailure(environment, artifact.reason || "composition_failed");
    }

    const invalid = this.verifySuccessReceipt(environment, artifact);
    if (invalid) return this.recordFailure(environment, invalid);

    const recipeSha256 = artifact.recipe_sha256!;
    const imageDigest = artifact.image_digest!;
    const recipe = artifact.recipe!;

    await this.environments.markReady(environment.environmentId, {
      recipeSha256,
      imageDigest,
      recipe,
      // The DTO does not validate this field; an unknown architecture is dropped here.
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
      image_architecture: artifact.image_architecture,
      reported_cliver: artifact.smoke_test?.reported_cliver,
      reported_rsver: artifact.smoke_test?.reported_rsver,
    });
    return { status: "ready", recipeSha256, imageDigest };
  }

  private verifySuccessReceipt(
    environment: EnvironmentRecord,
    artifact: ComposerArtifact,
  ): string | undefined {
    if (!artifact.recipe_sha256 || !artifact.image_digest || !artifact.recipe) {
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

  private recordDuration(environment: EnvironmentRecord, outcome: string): void {
    const seconds = (Date.now() - Date.parse(environment.createdAt)) / 1000;
    this.metrics.histogram("environment_composition_seconds", seconds, {
      outcome,
      template_version: environment.templateVersion,
    });
  }
}
