import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { EnvironmentsRepository, type EnvironmentRecord } from "@scvs/db";
import {
  ScvsLogger,
  ScvsMetrics,
  type ComposeIntent,
  type MaterializationResult,
  type MaterializedEnvironment,
} from "@scvs/core";
import { BuildEnvironmentMaterializer } from "./build-environment-materializer.js";
import { ComposerDispatchService } from "./composer-dispatch.service.js";

@Injectable()
export class CachingBuildEnvironmentMaterializer extends BuildEnvironmentMaterializer {
  private readonly logger = new ScvsLogger("build-environments");
  private readonly metrics = new ScvsMetrics("build-environments", { logger: this.logger });

  constructor(
    @Inject(EnvironmentsRepository) private readonly environments: EnvironmentsRepository,
    @Inject(ComposerDispatchService) private readonly composer: ComposerDispatchService,
  ) {
    super();
  }

  async materialize(
    intent: ComposeIntent,
    correlationId: string,
  ): Promise<MaterializationResult> {
    const environment = await this.environments.findOrCreate({
      environmentId: randomUUID(),
      cliver: intent.pair.cliver,
      rsver: intent.pair.rsver,
      templateVersion: intent.template_version,
    });

    switch (environment.status) {
      case "ready":
        return this.readyResult(environment);
      case "failed":
        this.logger.warn("environment composition previously failed; not retrying automatically", {
          environment_id: environment.environmentId,
          cliver: environment.cliver,
          rsver: environment.rsver,
          error_code: environment.errorCode,
          correlation_id: correlationId,
        });
        return {
          kind: "failed",
          environmentId: environment.environmentId,
          errorCode: environment.errorCode || "environment_composition_failed",
        };
      case "composing":
        return { kind: "composing", environmentId: environment.environmentId };
      case "pending":
        return this.tryCompose(environment, intent, correlationId);
    }
  }

  async findReadyByRecipeSha256(
    recipeSha256: string,
  ): Promise<MaterializedEnvironment | undefined> {
    const environment = await this.environments.findByRecipeSha256(recipeSha256);
    if (!environment || environment.status !== "ready") {
      this.logger.warn("no ready environment for a recipe hash a rebuild is already keyed on", {
        recipe_sha256: recipeSha256,
        found_status: environment?.status,
      });
      return undefined;
    }
    return this.materializedFrom(environment);
  }

  private async tryCompose(
    environment: EnvironmentRecord,
    intent: ComposeIntent,
    correlationId: string,
  ): Promise<MaterializationResult> {
    if (!(await this.environments.claimForComposing(environment.environmentId))) {
      this.logger.log("another tick is composing this environment, waiting", {
        environment_id: environment.environmentId,
        correlation_id: correlationId,
      });
      return { kind: "composing", environmentId: environment.environmentId };
    }

    this.metrics.counter("environment_composition_total", 1, {
      outcome: "dispatched",
      template_version: intent.template_version,
    });

    try {
      await this.composer.submitComposerJob({
        environmentId: environment.environmentId,
        intent,
      });
    } catch (error) {
      await this.environments.releaseClaim(environment.environmentId);
      this.metrics.counter("environment_composition_total", 1, {
        outcome: "dispatch_failed",
        template_version: intent.template_version,
      });
      this.logger.error("could not dispatch the composition; released the claim for a retry", {
        environment_id: environment.environmentId,
        correlation_id: correlationId,
        error: error instanceof Error ? error : String(error),
      });
      throw error;
    }

    return { kind: "composing", environmentId: environment.environmentId };
  }

  private readyResult(environment: EnvironmentRecord): MaterializationResult {
    const materialized = this.materializedFrom(environment);
    if (!materialized) {
      this.logger.error("a ready environment is missing its recorded identities", {
        environment_id: environment.environmentId,
        has_recipe_sha256: environment.recipeSha256 !== undefined,
        has_image_digest: environment.imageDigest !== undefined,
        has_recipe: environment.recipe !== undefined,
      });
      return {
        kind: "failed",
        environmentId: environment.environmentId,
        errorCode: "environment_record_incomplete",
      };
    }
    return {
      kind: "ready",
      environmentId: environment.environmentId,
      environment: materialized,
    };
  }

  private materializedFrom(
    environment: EnvironmentRecord,
  ): MaterializedEnvironment | undefined {
    if (!environment.recipeSha256 || !environment.imageDigest || !environment.recipe) {
      return undefined;
    }
    return {
      recipeSha256: environment.recipeSha256,
      imageDigest: environment.imageDigest,
      recipe: environment.recipe,
      ...(environment.arch ? { arch: environment.arch } : {}),
    };
  }
}
