import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createBatchClient,
  createS3Client,
  describeActiveJobDefinition,
  describeJob,
  presignGetUrl,
  presignPutUrl,
  putObjectText,
  submitJob,
  type RegisteredTaskProperties,
  type SubmitJobParams,
} from "@scvs/aws";
import type { StagingStorageConfig } from "@scvs/config";
import { JobsRepository, RebuildsRepository } from "@scvs/db";
import { ScvsLogger, type BuildMode } from "@scvs/core";
import {
  builderContainerParams,
  type BuilderInvocationParams,
} from "./builder-invocation.util.js";
import { ImagePlatformService } from "./image-platform.service.js";
import { selectJobQueue } from "./queue-selection.util.js";
import {
  assertWithinTaskPropertiesLimit,
  measureMergedTaskProperties,
  type MergedPayloadMeasurement,
  type OverrideContainer,
} from "./taskproperties-size.util.js";
import { canonicalSourceKey, paramsDocumentKey, rebuiltWasmKey, recipeArtifactKey } from "../../common/staging-keys.util.js";
import type { AppConfigService, JobParamsTransport } from "../../config/configuration.js";

/** Reads the Batch queue/job-definition ARNs and staging bucket/region from its own injected `ConfigService`. */
@Injectable()
export class BatchDispatchService {
  private readonly logger = new ScvsLogger("batch-dispatch");

  /**
   * Refreshed on TTL, so a re-registered definition is picked up within ten minutes without a
   * DescribeJobDefinitions call on every dispatch.
   */
  private readonly registeredDefinitions = new Map<
    string,
    {
      revision: number;
      fetchedAt: number;
      taskProperties: RegisteredTaskProperties["taskProperties"];
    }
  >();
  private static readonly REGISTERED_DEFINITION_TTL_MS = 10 * 60_000;

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(RebuildsRepository) private readonly rebuilds: RebuildsRepository,
    @Inject(ImagePlatformService) private readonly imagePlatform: ImagePlatformService
  ) {}

  /** Submits one AWS Batch job for a *rebuild* in the given `mode`. */
  async submitBatchJob(
    params: BuilderInvocationParams,
    mode: BuildMode
  ): Promise<string> {
    const staging =
      this.configService.get("stagingStorage", { infer: true });
    const s3 = createS3Client({ region: staging.region });
    const artifactKey = recipeArtifactKey(params.rebuildId, mode);
    const wasmKey = rebuiltWasmKey(params.rebuildId, mode);
    const canonicalKey = canonicalSourceKey(params.rebuildId, mode);
    // The third is the materialiser's, and it is minted unconditionally because whether it will be used is not
    // knowable here: only the materialiser, having read the bytes, can tell whether the archive it built from
    // is the one the trusted side already holds.
    const [uploadUrl, artifactUploadUrl, canonicalSourceUploadUrl] = await Promise.all([
      presignPutUrl(s3, staging.bucket, artifactKey, { contentType: "application/json" }),
      presignPutUrl(s3, staging.bucket, wasmKey, { contentType: "application/wasm" }),
      presignPutUrl(s3, staging.bucket, canonicalKey, { contentType: "application/octet-stream" }),
    ]);

    // One document per container, not one shared copy — see `builderContainerParams`.
    const containerParams = builderContainerParams(
      params,
      mode,
      uploadUrl,
      artifactUploadUrl,
      canonicalSourceUploadUrl,
    );
    const transport = this.configService.get("jobParamsTransport", { infer: true });
    const containers: OverrideContainer[] =
      transport === "presigned_url"
        ? await this.buildUrlTransportContainers(s3, staging.bucket, params.rebuildId, mode, containerParams)
        : this.buildInlineTransportContainers(containerParams);

    // Which queue, decided per rebuild rather than configured once: each compute environment is
    // single-architecture and the build image is pulled and executed *on that host*, so an amd64-only image
    // cannot run on the Graviton queue.
    const platform = params.imageArchitecture
      ? undefined
      : await this.imagePlatform.resolveArchitectures(params.imageDigest);
    const queue = selectJobQueue({
      architectures: platform?.architectures ?? [],
      defaultArch: this.configService.get("batchDefaultArch", { infer: true }),
      queueArns: this.configService.get("batchJobQueueArns", { infer: true }),
      jobDefinitions: this.configService.get("batchJobDefinitionArns", { infer: true }),
      ...(params.imageArchitecture ? { recordedArch: params.imageArchitecture } : {}),
    });
    const jobDefinitionArn = queue.jobDefinition;
    // Measured (cached per definition revision) and asserted here so an over-large payload fails in THIS log,
    // with its component sizes, instead of inside Batch with no logs, no recipe.json, and nothing to diagnose
    // from.
    const described = await this.measureMergedPayload(jobDefinitionArn, containers);
    if (described) assertWithinTaskPropertiesLimit(described.measurement);

    // `containerParams` is NEVER a field here: it carries presigned S3 URLs.
    this.logger.log("submitting Batch job", {
      rebuild_id: params.rebuildId,
      mode,
      job_queue: queue.jobQueueArn,
      build_arch: queue.arch,
      // Why this queue, in the one line that would be read while investigating a build that failed on the wrong
      // host family.
      queue_selection: queue.reason,
      // `undefined` when no probe was made, which is not the same fact as a probe that answered nothing —
      // `queue_selection` is what distinguishes them.
      image_architectures: platform?.architectures,
      job_definition: jobDefinitionArn,
      artifact_key: artifactKey,
      rebuilt_wasm_key: wasmKey,
      // Written only when the archive built from is not the one already held; named here for the same reason as
      // above, since "uploaded: true and no object" is the anomaly the outcome path fails on.
      canonical_source_key: canonicalKey,
      staging_bucket: staging.bucket,
      params_transport: transport,
      ...(transport === "presigned_url"
        ? {
            params_materialise_key: paramsDocumentKey(params.rebuildId, mode, "materialise"),
            params_runner_key: paramsDocumentKey(params.rebuildId, mode, "runner"),
          }
        : {}),
      // The number the 8192 ceiling is actually about is `taskproperties_bytes` below.
      overrides_bytes: described
        ? described.measurement.overrideBytes
        : Buffer.byteLength(JSON.stringify({ taskProperties: [{ containers }] })),
      // The merged measurement, or an explicit mark that it could not be taken: a DescribeJobDefinitions outage
      // must not take dispatching down with it, but it must not pass silently either.
      ...(described
        ? {
            static_bytes: described.measurement.staticBytes,
            taskproperties_bytes: described.measurement.totalBytes,
            job_definition_revision: described.revision,
          }
        : { taskproperties_measurement: "unavailable" }),
    });

    const batch = createBatchClient(staging.region);
    const { jobId: batchJobId } = await this.submitToBatch(batch, {
      jobName: `scvs-${mode}-${params.rebuildId}`,
      jobQueueArn: queue.jobQueueArn,
      jobDefinitionArn,
      ecsPropertiesOverride: { taskProperties: [{ containers }] },
    });

    this.logger.log("Batch accepted the submission", {
      rebuild_id: params.rebuildId,
      batch_job_id: batchJobId,
      mode,
    });
    // `dispatching -> running`.
    await this.rebuilds.markDispatched(params.rebuildId, { batchJobId, buildMode: mode });
    return batchJobId;
  }

  private buildInlineTransportContainers(containerParams: {
    materialise: unknown;
    runner: unknown;
  }): OverrideContainer[] {
    return [
      {
        name: this.configService.get("batchMaterialiseContainerName", { infer: true }),
        environment: [
          { name: "SCVS_JOB_PARAMS_JSON", value: JSON.stringify(containerParams.materialise) },
        ],
      },
      {
        name: this.configService.get("batchRunnerContainerName", { infer: true }),
        environment: [
          { name: "SCVS_JOB_PARAMS_JSON", value: JSON.stringify(containerParams.runner) },
        ],
      },
    ];
  }

  /**
   * The override then costs two bounded URLs instead of two documents that grow with the source — see the
   * decision doc this transport is named in.
   */
  private async buildUrlTransportContainers(
    s3: ReturnType<typeof createS3Client>,
    bucket: string,
    rebuildId: string,
    mode: BuildMode,
    containerParams: { materialise: unknown; runner: unknown },
  ): Promise<OverrideContainer[]> {
    const materialiseKey = paramsDocumentKey(rebuildId, mode, "materialise");
    const runnerKey = paramsDocumentKey(rebuildId, mode, "runner");
    await Promise.all([
      this.putParamsDocument(s3, bucket, materialiseKey, JSON.stringify(containerParams.materialise)),
      this.putParamsDocument(s3, bucket, runnerKey, JSON.stringify(containerParams.runner)),
    ]);
    // The fetch window starts when the container starts, which is the same clock the materialiser's
    // source-archive GET has always been on.
    const [materialiseUrl, runnerUrl] = await Promise.all([
      presignGetUrl(s3, bucket, materialiseKey),
      presignGetUrl(s3, bucket, runnerKey),
    ]);
    return [
      {
        name: this.configService.get("batchMaterialiseContainerName", { infer: true }),
        environment: [{ name: "SCVS_JOB_PARAMS_URL", value: materialiseUrl }],
      },
      {
        name: this.configService.get("batchRunnerContainerName", { infer: true }),
        environment: [{ name: "SCVS_JOB_PARAMS_URL", value: runnerUrl }],
      },
    ];
  }

  /** Measures the merged payload against the live registered definition. */
  private async measureMergedPayload(
    jobDefinition: string,
    containers: OverrideContainer[],
  ): Promise<{ measurement: MergedPayloadMeasurement; revision: number } | undefined> {
    const region = this.configService.get("stagingStorage", { infer: true }).region;
    const batch = createBatchClient(region);
    try {
      const held = this.registeredDefinitions.get(jobDefinition);
      let registered =
        held &&
        Date.now() - held.fetchedAt < BatchDispatchService.REGISTERED_DEFINITION_TTL_MS
          ? held
          : undefined;
      if (!registered) {
        const described = await this.describeRegisteredDefinition(batch, jobDefinition);
        if (!described) {
          this.logger.warn(
            "no ACTIVE ecsProperties job definition to measure the payload against",
            { job_definition: jobDefinition },
          );
          return undefined;
        }
        registered = {
          revision: described.revision,
          fetchedAt: Date.now(),
          taskProperties: described.taskProperties,
        };
        this.registeredDefinitions.set(jobDefinition, registered);
      }
      return {
        measurement: measureMergedTaskProperties(containers, {
          revision: registered.revision,
          taskProperties: registered.taskProperties,
        }),
        revision: registered.revision,
      };
    } catch (error) {
      this.logger.warn("merged-payload measurement failed", {
        job_definition: jobDefinition,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * The outbound requests `submitBatchJob` can send, isolated as methods so a suite can substitute them
   * (`jest.spyOn`) while the dispatch around them stays real. Presigning is not among them: it signs locally
   * and sends nothing.
   */
  protected putParamsDocument(
    s3: ReturnType<typeof createS3Client>,
    bucket: string,
    key: string,
    body: string,
  ): Promise<void> {
    return putObjectText(s3, bucket, key, body, "application/json");
  }

  protected describeRegisteredDefinition(
    batch: ReturnType<typeof createBatchClient>,
    familyOrArn: string,
  ): Promise<RegisteredTaskProperties | undefined> {
    return describeActiveJobDefinition(batch, familyOrArn);
  }

  protected submitToBatch(
    batch: ReturnType<typeof createBatchClient>,
    params: SubmitJobParams,
  ): Promise<{ jobId: string }> {
    return submitJob(batch, params);
  }

  /**
   * Asks AWS Batch what a job's state actually is — the input to `scheduler/rebuild-reconciler.scheduler.ts`,
   * for rebuilds whose terminal SQS event never arrived.
   */
  async describeBatchJob(
    batchJobId: string
  ): Promise<{ status: string; statusReason?: string } | undefined> {
    const { region } = this.configService.get("stagingStorage", { infer: true });
    const job = await describeJob(createBatchClient(region), batchJobId);
    if (!job) return undefined;
    return {
      status: job.status,
      ...(job.statusReason ? { statusReason: job.statusReason } : {}),
    };
  }

  /**
   * A rebuild left in `dispatching` was mid-`SubmitJob` when a process stopped: it won the claim but
   * `markDispatched` never ran, so Batch almost certainly never accepted anything.
   */
  async recoverJobsOnStartup(): Promise<{
    queued: number;
    reset_rebuilds: number;
  }> {
    const stuck = await this.rebuilds.listStuckDispatching();
    for (const rebuild of stuck) {
      // O6: an interrupted dispatch becomes retryable work rather than a lost job.
      this.logger.warn("rebuild was mid-dispatch when the process stopped, resetting to pending", {
        rebuild_id: rebuild.rebuildId,
      });
      await this.rebuilds.releaseClaim(rebuild.rebuildId);
    }

    const queued = await this.jobs.listJobsByStatus(["queued"]);
    return { queued: queued.length, reset_rebuilds: stuck.length };
  }
}
