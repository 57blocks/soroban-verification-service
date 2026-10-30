import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ComposerJobParams as ComposerJobParamsDto,
  composedEnvironmentRecipeHash,
  parseDto,
  type ComposedEnvironmentRecipe,
  type ComposerArtifact,
  type ComposerJobParams,
  type ComposerSmokeTest,
  type RecordedToolchainPair,
} from "@scvs/core";
import { ComponentError, fetchAndVerifyComponents } from "./components.js";
import { ImageError, buildComposedImage, pushComposedImage, smokeTestComposedImage } from "./image.js";
import { CompositionTemplateError, loadCompositionTemplate, templateDirFor } from "./template.js";
import { uploadComposerArtifact } from "./upload.js";
import type { AppConfigService } from "../../config/configuration.js";

export type ComposerRunResult = {
  line: Record<string, unknown>;
  exitCode: number;
};

const EXIT_CODES = { reported: 0, receipt_undeliverable: 1, fatal: 3 } as const;

const SCHEMA = "scvs-composer-artifact-v1" as const;

export function contextWithMessage(error: ComponentError | ImageError): Record<string, unknown> {
  return { ...error.context, message: error.message };
}

export type SmokeTestVerdict =
  | { readonly agreed: true }
  | {
      readonly agreed: false;
      readonly reason: "smoke_test_disagreed";
      readonly context: Record<string, unknown>;
    };

export function evaluateSmokeTest(
  pair: RecordedToolchainPair,
  smokeTest: ComposerSmokeTest,
): SmokeTestVerdict {
  if (smokeTest.matches_pair) return { agreed: true };
  return {
    agreed: false,
    reason: "smoke_test_disagreed",
    context: {
      requested_cliver: pair.cliver,
      requested_rsver: pair.rsver,
      reported_cliver: smokeTest.reported_cliver,
      reported_rsver: smokeTest.reported_rsver,
    },
  };
}

@Injectable()
export class ComposerService {
  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  async run(): Promise<ComposerRunResult> {
    let params: ComposerJobParams;
    try {
      params = this.readParams();
    } catch (error) {
      return {
        exitCode: EXIT_CODES.fatal,
        line: {
          schema: SCHEMA,
          classification: "composition_failure",
          reason: "composer_params_invalid",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const workdir = await mkdtemp(join(this.configService.get("artifactDir", { infer: true }) || tmpdir(), "compose-"));
    const contextDir = join(workdir, "context");
    await mkdir(contextDir, { recursive: true });

    try {
      const artifact = await this.compose(params, contextDir);
      const upload = await uploadComposerArtifact(params.upload_url, artifact);
      if (!upload.ok) {
        return {
          exitCode: EXIT_CODES.receipt_undeliverable,
          line: {
            schema: SCHEMA,
            environment_id: params.environment_id,
            classification: artifact.classification,
            reason: "receipt_upload_failed",
            detail: upload.detail,
          },
        };
      }
      return {
        exitCode: EXIT_CODES.reported,
        line: {
          schema: SCHEMA,
          environment_id: params.environment_id,
          classification: artifact.classification,
          ...(artifact.recipe_sha256 ? { recipe_sha256: artifact.recipe_sha256 } : {}),
          ...(artifact.image_digest ? { image_digest: artifact.image_digest } : {}),
          ...(artifact.reason ? { reason: artifact.reason } : {}),
        },
      };
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async compose(
    params: ComposerJobParams,
    contextDir: string,
  ): Promise<ComposerArtifact> {
    const templateRoot = this.configService.get("templateDir", { infer: true });
    const composedAt = new Date().toISOString();

    try {
      const template = await loadCompositionTemplate(templateRoot, params.template_version);

      const { components } = await fetchAndVerifyComponents({
        pair: params.pair,
        template,
        contextDir,
        timeoutMs: this.configService.get("componentFetchTimeoutMs", { infer: true }),
      });

      // The recipe — and therefore `recipe_sha256` — is fixed *before* the build runs.
      const recipe: ComposedEnvironmentRecipe = {
        schema: "scvs-composed-environment-v1",
        pair: params.pair,
        template_version: template.templateVersion,
        components,
      };
      const recipeSha256 = composedEnvironmentRecipeHash(recipe);

      const dockerHost = this.configService.get("dockerHost", { infer: true });
      await buildComposedImage({
        environmentId: params.environment_id,
        pair: params.pair,
        template,
        templateDir: templateDirFor(templateRoot, params.template_version),
        contextDir,
        timeoutMs: this.configService.get("buildTimeoutMs", { infer: true }),
        ...(dockerHost ? { dockerHost } : {}),
      });

      const smokeTest = await smokeTestComposedImage({
        environmentId: params.environment_id,
        pair: params.pair,
        timeoutMs: this.configService.get("componentFetchTimeoutMs", { infer: true }),
        ...(dockerHost ? { dockerHost } : {}),
      });
      const verdict = evaluateSmokeTest(params.pair, smokeTest);
      if (!verdict.agreed) {
        // The `return` *is* the control — `pushComposedImage` is below it — so keep this branch terminal.
        return this.failure(params, composedAt, verdict.reason, verdict.context, smokeTest);
      }

      const pushed = await pushComposedImage({
        environmentId: params.environment_id,
        recipeSha256,
        ecrRepositoryUri: params.ecr_repository_uri,
        timeoutMs: this.configService.get("buildTimeoutMs", { infer: true }),
        ...(dockerHost ? { dockerHost } : {}),
      });

      return {
        schema: SCHEMA,
        environment_id: params.environment_id,
        classification: "success",
        composed_at: composedAt,
        recipe_sha256: recipeSha256,
        image_digest: pushed.digest,
        ...(pushed.architecture ? { image_architecture: pushed.architecture } : {}),
        recipe,
        smoke_test: smokeTest,
      };
    } catch (error) {
      if (
        error instanceof ComponentError ||
        error instanceof ImageError
      ) {
        return this.failure(params, composedAt, error.reason, contextWithMessage(error));
      }
      if (error instanceof CompositionTemplateError) {
        return this.failure(params, composedAt, error.reason, {
          template_version: params.template_version,
          detail: error.message,
        });
      }
      return this.failure(params, composedAt, "composer_internal_error", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private failure(
    params: ComposerJobParams,
    composedAt: string,
    reason: string,
    context: Record<string, unknown>,
    smokeTest?: ComposerSmokeTest,
  ): ComposerArtifact {
    return {
      schema: SCHEMA,
      environment_id: params.environment_id,
      classification: "composition_failure",
      composed_at: composedAt,
      reason,
      failure_context: context,
      ...(smokeTest ? { smoke_test: smokeTest } : {}),
    };
  }

  private readParams(): ComposerJobParams {
    const raw = this.configService.get("composerParamsJson", { infer: true });
    if (!raw) {
      throw new Error(
        "SCVS_COMPOSER_PARAMS_JSON is required — it is the composer's entire input, injected per job.",
      );
    }
    return parseDto(ComposerJobParamsDto, JSON.parse(raw));
  }
}
