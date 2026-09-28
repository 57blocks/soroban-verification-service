import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  composedEnvironmentRecipeHash,
  composedEnvironmentImageReference,
  parseRebuildEnvironmentIdentity,
  ScvsLogger,
  ScvsMetrics,
} from "@scvs/core";
import {
  EnvironmentsRepository,
  JobsRepository,
  RebuildsRepository,
  type JobRecord,
  type RebuildRecord,
} from "@scvs/db";
import {
  appendVerifiedSourceCodeUri,
  buildWasmStatus,
  createResultStorage,
  mutateWasmStatus,
  publishReport,
  publishSource,
  readLegacyCustody,
  reportKey,
  type ResultStorage,
  sourceFileExtension,
  sourceKeyFromFileName,
  sourceSha256FromFileName,
} from "@scvs/storage-layout";
import type {
  BuildMode,
  MechanismReason,
  RegistrySourceCodeUri,
  VerificationResultSummary as VerificationResultSummaryDto,
} from "@scvs/core";
import {
  assembleArtifact,
  toBldarg,
  toBldopt,
  toBuildIsolation,
  type PublishedBuildEnvironment,
} from "./artifact-builder.util.js";
import { ArweaveArchiveService } from "./arweave-archive.service.js";
import {
  declareSourceFileName,
  fetchSourceBytesForPublishing,
  type CanonicalSource,
} from "../source-resolution/index.js";
import { toStatusLinkOutcome } from "./status-link-outcome.util.js";
import { SourceResolutionService } from "../source-resolution/index.js";
import type { AppConfigService } from "../../config/configuration.js";
import { ConfigurationError } from "../../config/configuration-error.js";

@Injectable()
export class PublishService {
  private readonly logger = new ScvsLogger("publish");
  private readonly metrics = new ScvsMetrics("publish", { logger: this.logger });

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(ArweaveArchiveService) private readonly arweaveArchive: ArweaveArchiveService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(RebuildsRepository) private readonly rebuilds: RebuildsRepository,
    @Inject(EnvironmentsRepository) private readonly environments: EnvironmentsRepository,
    @Inject(SourceResolutionService) private readonly sourceResolution: SourceResolutionService,
  ) {}

  async publishJobResult(jobId: string): Promise<void> {
    const job = await this.jobs.getJobById(jobId);
    if (!job) {
      throw new Error(`publishJobResult: job ${jobId} not found.`);
    }
    const preliminary = job.result as VerificationResultSummaryDto | undefined;
    if (!preliminary) {
      throw new Error(`publishJobResult: job ${jobId} has no preliminary result to publish.`);
    }

    if (!(await this.jobs.claimForPublish(jobId))) {
      this.logger.log("another worker is already publishing this job, skipping", {
        job_id: jobId,
        observed_status: job.status,
      });
      return;
    }

    if (preliminary.matched === undefined) {
      this.logger.warn(
        "build completed but rebuilt_wasm_hash is missing; failing with comparison_not_available",
        { job_id: jobId },
      );
      await this.jobs.advanceJob(jobId, "publishing", "failed", {
        failureReason: "internal_error",
        error: "comparison_not_available",
        result: {
          ...preliminary,
          status_summary: "build_failed",
          reason: "comparison_not_available",
          detail:
            "The build-only fallback path completed, but the build artifact did not report a " +
            "rebuilt_wasm_hash, so it could not be compared against the deployed hash.",
          verified_at: new Date().toISOString(),
        },
        progress: undefined,
      });
      await this.sourceResolution.deleteStagedUpload(job.sourceRef);
      return;
    }

    const matched = preliminary.matched;
    // Strip the prior publish's own fields, or they hash into a different artifact and defeat upload dedup.
    const { artifact_url: _artifactUrl, artifact_sha256: _artifactSha256, arweave_tx_id: _arweaveTxId, ...priorPublishInput } = preliminary;
    const finalResult: VerificationResultSummaryDto = {
      ...priorPublishInput,
      status_summary: matched ? "verified" : "mismatch",
      verified_at: preliminary.verified_at || new Date().toISOString(),
    };

    try {
      await this.writePublication(job, finalResult, matched);
    } catch (error) {
      await this.recordPublishFailure(job, error);
      throw error;
    }
  }

  async republishStoredResult(jobId: string): Promise<void> {
    const job = await this.jobs.getJobById(jobId);
    if (!job) throw new Error(`republishStoredResult: job ${jobId} not found.`);
    const stored = job.result as VerificationResultSummaryDto | undefined;
    if (!stored || stored.matched === undefined) {
      throw new Error(`republishStoredResult: job ${jobId} has no comparison to republish.`);
    }
    const { artifact_url: _artifactUrl, artifact_sha256: _artifactSha256, arweave_tx_id: _arweaveTxId, ...reassemblyInput } = stored;
    await this.writePublication(job, reassemblyInput, stored.matched, { ownsRow: false });
  }

  private async writePublication(
    job: JobRecord,
    finalResult: VerificationResultSummaryDto,
    matched: boolean,
    options: { ownsRow: boolean } = { ownsRow: true },
  ): Promise<void> {
    const jobId = job.jobId;

    const verifier = this.configService.get("verifierIdentity", { infer: true });
    const storage = this.buildResultStorage();
    const { buildMode, mechanismReason, buildEnvironment, canonicalSource, chainSourceSha256 } =
      await this.resolveBuildContext(job);
    const buildIsolation = toBuildIsolation(buildMode);
    const sourceFileName =
      job.sourceRef.visibility === "public"
        ? await declareSourceFileName(job.sourceRef, this.sourceResolution, canonicalSource)
        : undefined;
    const artifact = assembleArtifact(
      { ...job, result: finalResult },
      verifier,
      buildIsolation,
      buildEnvironment,
      sourceFileName,
      mechanismReason,
      canonicalSource?.sha256,
      chainSourceSha256,
    );
    const { sha256: reportSha256, bytes: reportBytes } = await publishReport(storage, artifact);
    const reportUrl = `${storage.publicRoot}/${reportKey(reportSha256)}`;

    this.logger.log("publishing result", {
      job_id: jobId,
      status_summary: finalResult.status_summary,
      report_sha256: reportSha256,
      wasm_hash: finalResult.wasm_hash,
    });

    const now = finalResult.verified_at || new Date().toISOString();

    const sourceDurable = await this.attemptSourcePublish(
      job,
      storage,
      sourceFileName,
      jobId,
      canonicalSource,
    );
    const verifiedSourceCodeUri: RegistrySourceCodeUri | undefined =
      sourceDurable && sourceFileName
        ? { location: "verifier_self_storage", url: verifiedSourceCodeUrl(storage, sourceFileName) }
        : undefined;

    const sourceArchiveEligible = this.isSourceArchiveEligible(job, sourceDurable, sourceFileName);

    const thisVerdict = matched ? "verified" : "mismatched";
    const ownIdentity = { name: verifier.displayName, url: storage.publicRoot };
    // Decided inside the mutation, against the bytes this compare-and-swap writes; an outside read can be stale.
    const statusOutcome = await mutateWasmStatus(storage, finalResult.wasm_hash, (existing) => {
      const build = buildWasmStatus({
        existing,
        wasmHash: finalResult.wasm_hash,
        verifier: ownIdentity,
        verdict: thisVerdict,
        recipeSource: artifact.provenance.recipe_source,
        imageTrustLevel: buildEnvironment.trustLevel,
        bldimg: buildEnvironment.buildImage,
        bldarg: toBldarg(job.buildOptions),
        bldopt: toBldopt(job.buildOptions),
        sourceSha256: artifact.source.source_sha256,
        sourceUri: job.sourceRef.source_uri,
        ...(matched ? {} : { rebuiltHash: finalResult.rebuilt_wasm_hash }),
        processedAt: now,
        resultsUrls: [{ type: "report", location: "verifier_self_storage", url: reportUrl, sha256: reportSha256 }],
        ...(verifiedSourceCodeUri ? { verifiedSourceCodeUris: [verifiedSourceCodeUri] } : {}),
      });
      return build.outcome === "write" ? { write: build.document } : { skip: "superseded" };
    });
    if (statusOutcome !== "written" && statusOutcome !== "superseded") {
      throw new Error(
        `publishJobResult: job ${jobId} could not write wasms/${finalResult.wasm_hash}.json (${statusOutcome})`,
      );
    }
    const wasmStatusChanged = statusOutcome === "written";

    if (!options.ownsRow) {
      this.logger.log("re-wrote a published job's objects; the row was already correct", {
        job_id: jobId,
        report_sha256: reportSha256,
      });
      return;
    }

    const recorded = await this.jobs.advanceJob(jobId, "publishing", "published", {
      verdict: thisVerdict,
      result: { ...finalResult, artifact_url: reportUrl, artifact_sha256: reportSha256 },
      progress: undefined,
      archivePendingSince: new Date(now),
      ...(wasmStatusChanged ? { publishedUpdatedAt: new Date(now) } : {}),
      ...(job.sourceRef.visibility === "public"
        ? { sourcePublishPendingSince: sourceDurable ? null : new Date(now) }
        : {}),
      ...(sourceArchiveEligible ? { sourceArchivePendingSince: new Date(now) } : {}),
    });

    if (!recorded) {
      throw new Error(
        `publishJobResult: job ${jobId} left "publishing" while its result was being written; ` +
          "another worker owns this publication.",
      );
    }

    if (job.sourceRef.visibility === "public") {
      try {
        await this.jobs.recordSourcePublishOutcome(
          jobId,
          sourceDurable && sourceFileName
            ? { published: true, sourceFileName, owesStatusLink: false }
            : { published: false },
        );
      } catch (error) {
        this.logger.warn("failed to record source-publish outcome; the retry scheduler will catch up", {
          job_id: jobId,
          error: error instanceof Error ? error : String(error),
        });
      }
    }

    // Only after sources/ is durable: the staged upload may be the only copy of the source.
    if (sourceDurable) {
      await this.sourceResolution.deleteStagedUpload(job.sourceRef);
    }

    this.arweaveArchive.scheduleArweaveBackfill({
      jobId,
      storage,
      wasmHash: finalResult.wasm_hash,
      reportUrl,
      reportSha256,
      reportBytes,
      verifierId: verifier.id,
    });

    if (sourceArchiveEligible) {
      await this.maybeScheduleSourceArchive(job, storage, sourceFileName, reportUrl);
    }
    this.logger.log("published", {
      job_id: jobId,
      outcome: thisVerdict,
      report_url: reportUrl,
    });

    const path = buildMode === "verify" ? "cli" : "independent";
    this.metrics.counter("verdict_total", 1, { verdict: thisVerdict, path });
    this.metrics.histogram(
      "job_duration_seconds",
      (Date.now() - Date.parse(job.createdAt)) / 1000,
      { outcome: thisVerdict, path },
    );
  }

  private async attemptSourcePublish(
    job: JobRecord,
    storage: ResultStorage,
    sourceFileName: string | undefined,
    jobId: string,
    canonicalSource?: CanonicalSource,
  ): Promise<boolean> {
    if (job.sourceRef.visibility !== "public") return true;
    if (!job.sourceRef.source_sha256 || !sourceFileName) return false;

    const alreadyPublished = await storage.exists(sourceKeyFromFileName(sourceFileName));
    if (alreadyPublished) return true;

    const fetched = await fetchSourceBytesForPublishing(
      job.sourceRef,
      this.sourceResolution,
      canonicalSource,
    );
    if (!fetched) {
      this.logger.warn("declared-public source could not be fetched for publishing; sources/ was not written", {
        job_id: jobId,
        source_ref_type: job.sourceRef.type,
        source_sha256: job.sourceRef.source_sha256,
        source_file_name: sourceFileName,
      });
      return false;
    }

    await publishSource(storage, {
      sourceSha256: canonicalSource?.sha256 ?? job.sourceRef.source_sha256,
      bytes: fetched.bytes,
      extension: fetched.extension,
      contentType: "application/octet-stream",
    });
    return true;
  }

  private isSourceArchiveEligible(job: JobRecord, sourceDurable: boolean, sourceFileName: string | undefined): boolean {
    return (
      this.configService.get("arweave", { infer: true }).sourceArchiveEnabled &&
      sourceDurable &&
      job.sourceRef.visibility === "public" &&
      job.target.network === "mainnet" &&
      !!job.sourceRef.source_sha256 &&
      !!sourceFileName &&
      !!job.target.wasm_hash
    );
  }

  private async maybeScheduleSourceArchive(
    job: JobRecord,
    storage: ResultStorage,
    sourceFileName: string | undefined,
    reportUrl: string,
  ): Promise<void> {
    const sourceBytes = await storage.readBytes(sourceKeyFromFileName(sourceFileName!));
    if (!sourceBytes) {
      this.logger.warn("source archive eligible but sources/ was unreadable immediately after publish", {
        job_id: job.jobId,
      });
      return;
    }

    this.arweaveArchive.scheduleSourceArchive({
      jobId: job.jobId,
      storage,
      wasmHash: job.target.wasm_hash!,
      reportUrl,
      sourceSha256: sourceSha256FromFileName(sourceFileName!),
      sourceBytes,
      sourceExtension: sourceFileExtension(sourceFileName!, sourceSha256FromFileName(sourceFileName!)),
      verifierId: this.configService.get("verifierIdentity", { infer: true }).id,
    });
  }

  async retryPendingSourcePublish(job: JobRecord): Promise<void> {
    if (job.sourceRef.visibility !== "public") {
      this.logger.error(`job ${job.jobId}: pending source publish but sourceRef is not public — skipping`);
      return;
    }
    const storage = this.buildResultStorage();
    const { canonicalSource } = await this.resolveBuildContext(job);
    const sourceFileName = await declareSourceFileName(
      job.sourceRef,
      this.sourceResolution,
      canonicalSource,
    );
    const durable = await this.attemptSourcePublish(
      job,
      storage,
      sourceFileName,
      job.jobId,
      canonicalSource,
    );

    const sourceArchiveEligible =
      !!job.result?.artifact_url && this.isSourceArchiveEligible(job, durable, sourceFileName);

    await this.jobs.recordSourcePublishOutcome(
      job.jobId,
      durable
        ? {
            published: true,
            sourceFileName,
            owesStatusLink: true,
            ...(sourceArchiveEligible ? { sourceArchivePendingSince: new Date() } : {}),
          }
        : { published: false },
    );
    if (durable) {
      await this.sourceResolution.deleteStagedUpload(job.sourceRef);
      if (sourceFileName) {
        // Full recompute, not a lone append: only a pass that rebuilds every owed link may discharge the obligation.
        await this.arweaveArchive.retryPendingStatusLinks({ ...job, sourceFileName });
        if (sourceArchiveEligible) {
          await this.maybeScheduleSourceArchive(job, storage, sourceFileName, job.result!.artifact_url!);
        }
      }
    }
  }

  async completeArchiveObligationsForAdoptedJob(job: JobRecord, prior: JobRecord): Promise<void> {
    if (job.sourceRef.visibility !== "public") return;
    if (!prior.result?.wasm_hash || !prior.result.artifact_url) {
      this.logger.error(
        `job ${job.jobId}: adopted from ${prior.jobId}, which carries no published result — cannot locate its wasms/<hash>.json entry`,
      );
      return;
    }
    try {
      await this.jobs.updateJob(job.jobId, { sourcePublishPendingSince: new Date() });
    } catch (error) {
      this.logger.warn("failed to mark an adopted job's archive obligation; nothing will retry it", {
        job_id: job.jobId,
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  private async recordPublishFailure(job: JobRecord, error: unknown): Promise<void> {
    const attempts = job.publishAttempts + 1;
    const max = this.configService.get("maxPublishAttempts", { infer: true });
    const abandoned = attempts >= max;

    this.logger.error(
      abandoned
        ? "publish attempt failed; giving up, no further automatic retries"
        : "publish attempt failed; will retry",
      {
        job_id: job.jobId,
        attempt: attempts,
        max_attempts: max,
        error: error instanceof Error ? error : String(error),
      },
    );

    await this.jobs
      .advanceJob(job.jobId, "publishing", "publish_pending", {
        publishAttempts: attempts,
        progress: {
          step: abandoned ? "publish_abandoned" : "publish_failed",
          detail: abandoned
            ? `Verification finished, but publishing the result failed ${attempts} times and will not be retried automatically. This needs an operator to check the result-storage configuration.`
            : `Verification finished; publishing the result failed (attempt ${attempts} of ${max}) and will be retried.`,
        },
      })
      .catch((updateError) => {
        this.logger.error("could not even record the publish failure", {
          job_id: job.jobId,
          error: updateError instanceof Error ? updateError : String(updateError),
        });
      });
  }

  // An instance method so tests can substitute it.
  private buildResultStorage(): ResultStorage {
    return createResultStorage(this.configService.get("resultStorage", { infer: true }));
  }

  private async resolveBuildContext(job: JobRecord): Promise<{
    buildMode: BuildMode;
    mechanismReason: MechanismReason;
    buildEnvironment: PublishedBuildEnvironment;
    canonicalSource?: CanonicalSource;
    chainSourceSha256?: string;
  }> {
    const rebuild = job.rebuildId ? await this.rebuilds.getById(job.rebuildId) : undefined;

    if (!rebuild) {
      throw new Error(`publishJobResult: job ${job.jobId} has no rebuild environment identity.`);
    }

    return {
      buildMode: rebuild.buildMode ?? "verify",
      mechanismReason: rebuild.mechanismReason,
      buildEnvironment: await this.resolvePublishedBuildEnvironment(rebuild),
      ...(rebuild.canonicalSourceSha256 && rebuild.canonicalSourceKey
        ? { canonicalSource: canonicalSourceOf(rebuild) }
        : {}),
      ...(rebuild.chainSourceSha256 ? { chainSourceSha256: rebuild.chainSourceSha256 } : {}),
    };
  }

  private async resolvePublishedBuildEnvironment(
    rebuild: RebuildRecord,
  ): Promise<PublishedBuildEnvironment> {
    const identity = parseRebuildEnvironmentIdentity(rebuild.imageDigest);
    if (identity.kind === "chain_named") {
      return {
        kind: "chain_named",
        trustLevel: "sdf_trusted",
        buildImage: identity.image,
      };
    }

    const environment = await this.environments.findByRecipeSha256(identity.recipeSha256);
    if (
      !environment ||
      environment.status !== "ready" ||
      environment.recipeSha256 !== identity.recipeSha256 ||
      !environment.imageDigest ||
      !environment.recipe ||
      composedEnvironmentRecipeHash(environment.recipe) !== identity.recipeSha256
    ) {
      throw new Error(
        `publishJobResult: rebuild ${rebuild.rebuildId} references composed recipe ` +
          `${identity.recipeSha256}, but no complete ready Environment exists.`,
      );
    }

    const repositoryUri = this.configService.get("composedEnvironmentRepositoryUri", { infer: true });
    if (!repositoryUri) {
      throw new ConfigurationError(
        "SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI",
        "SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI is required to publish composed-environment evidence.",
      );
    }
    return {
      kind: "composed",
      trustLevel: "upstream_pinned",
      buildImage: composedEnvironmentImageReference(repositoryUri, environment.imageDigest),
      recipeSha256: environment.recipeSha256,
      imageDigest: environment.imageDigest,
      recipe: environment.recipe,
    };
  }
}

function verifiedSourceCodeUrl(storage: ResultStorage, sourceFileName: string): string {
  return `${storage.publicRoot}/${sourceKeyFromFileName(sourceFileName)}`;
}

function canonicalSourceOf(rebuild: RebuildRecord): CanonicalSource {
  const record = rebuild.sourceCanonicalisation as { canonical_format?: string } | undefined;
  return {
    sha256: rebuild.canonicalSourceSha256!,
    key: rebuild.canonicalSourceKey!,
    ...(record?.canonical_format ? { format: record.canonical_format } : {}),
  };
}
