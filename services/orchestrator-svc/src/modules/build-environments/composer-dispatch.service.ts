import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createBatchClient, createS3Client, describeJob, presignPutUrl, submitJob } from "@scvs/aws";
import { EnvironmentsRepository } from "@scvs/db";
import { ScvsLogger, type ComposeIntent, type ComposerJobParams } from "@scvs/core";
import type { AppConfigService } from "../../config/configuration.js";
import { ConfigurationError } from "../../config/configuration-error.js";

export function composerArtifactKey(environmentId: string): string {
  return `staging/environments/${environmentId}/composer.json`;
}

@Injectable()
export class ComposerDispatchService {
  private readonly logger = new ScvsLogger("composer-dispatch");

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(EnvironmentsRepository) private readonly environments: EnvironmentsRepository,
  ) {}

  async submitComposerJob(input: {
    environmentId: string;
    intent: ComposeIntent;
  }): Promise<string> {
    const staging = this.configService.get("stagingStorage", { infer: true });
    const jobQueueArn = this.requireConfig(
      this.configService.get("composerJobQueueArn", { infer: true }),
      "SCVS_COMPOSER_JOB_QUEUE_ARN",
    );
    const jobDefinitionArn = this.requireConfig(
      this.configService.get("composerJobDefinitionArn", { infer: true }),
      "SCVS_COMPOSER_JOB_DEFINITION_ARN",
    );
    const ecrRepositoryUri = this.requireConfig(
      this.configService.get("composedEnvironmentRepositoryUri", { infer: true }),
      "SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI",
    );

    const artifactKey = composerArtifactKey(input.environmentId);
    const s3 = createS3Client({ region: staging.region });
    const uploadUrl = await presignPutUrl(s3, staging.bucket, artifactKey, {
      contentType: "application/json",
    });

    const params: ComposerJobParams = {
      environment_id: input.environmentId,
      pair: input.intent.pair,
      template_version: input.intent.template_version,
      ecr_repository_uri: ecrRepositoryUri,
      upload_url: uploadUrl,
    };

    this.logger.log("submitting a composition to the composer fleet", {
      environment_id: input.environmentId,
      cliver: input.intent.pair.cliver,
      rsver: input.intent.pair.rsver,
      template_version: input.intent.template_version,
      job_queue_arn: jobQueueArn,
      job_definition_arn: jobDefinitionArn,
      artifact_key: artifactKey,
    });

    const batch = createBatchClient(staging.region);
    const { jobId: batchJobId } = await submitJob(batch, {
      jobName: `scvs-compose-${input.environmentId}`,
      jobQueueArn,
      jobDefinitionArn,
      containerOverrides: {
        environment: [
          {
            // Distinct from the builder's SCVS_JOB_PARAMS_JSON so a misrouted submission cannot look well-formed.
            name: "SCVS_COMPOSER_PARAMS_JSON",
            value: JSON.stringify(params),
          },
        ],
      },
    });

    this.logger.log("Batch accepted the composition", {
      environment_id: input.environmentId,
      batch_job_id: batchJobId,
    });
    await this.environments.markComposing(input.environmentId, batchJobId);
    return batchJobId;
  }

  async describeBatchJob(
    batchJobId: string,
  ): Promise<{ status: string; statusReason?: string } | undefined> {
    const { region } = this.configService.get("stagingStorage", { infer: true });
    const job = await describeJob(createBatchClient(region), batchJobId);
    if (!job) return undefined;
    return {
      status: job.status,
      ...(job.statusReason ? { statusReason: job.statusReason } : {}),
    };
  }

  private requireConfig(value: string | undefined, envName: string): string {
    if (!value) {
      throw new ConfigurationError(
        envName,
        `${envName} is required to compose a build environment for a cli-legacy target. ` +
          "Set the composer fleet's configuration (clients/docs/src/self-hosting/requirements.md), or expect " +
          "every cli-legacy verification to fail preparation.",
      );
    }
    return value;
  }
}
