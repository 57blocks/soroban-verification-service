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
  readSourceBytesForPublishing,
  type CanonicalSource,
  type StagedSourceLocator,
} from "../source-resolution/index.js";
import { toStatusLinkOutcome } from "./status-link-outcome.util.js";
import { SourceResolutionService, StagedSourceReleaseService } from "../source-resolution/index.js";
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
    @Inject(StagedSourceReleaseService) private readonly stagedSourceRelease: StagedSourceReleaseService,
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
      await this.stagedSourceRelease.releaseForTerminalJob(job);
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
    const written = await this.writePublication(job, reassemblyInput, stored.matched, { ownsRow: false });

    // A private job's earlier report may carry the source_uri it no longer publishes. Point its row at the report
    // just written, and forget the earlier report's permanent copy (archived_tx_id), which cannot be withdrawn: kept,
    // the status-link recovery would link it to the new report. The new report owes its own copy, so the archive
    // retry picks it up.
    // A public job that adopted a private job's verdict before reports withheld source_uri points at that job's
    // report, which carries it: it is pointed at its own report the same way.
    const repoint =
      written &&
      written.reportUrl !== stored.artifact_url &&
      (job.sourceRef.visibility === "private" || (await this.storedReportIsPrivate(stored)));
    if (written && repoint) {
      const { arweave_tx_id: _staleCopy, ...kept } = stored;
      await this.jobs.updateJob(jobId, {
        result: { ...kept, artifact_url: written.reportUrl, artifact_sha256: written.reportSha256 },
        archivedTxId: null,
        archivePendingSince: new Date(),
      });
      this.logger.log("pointed a job at its rewritten report", {
        job_id: jobId,
        report_sha256: written.reportSha256,
        dropped_archive: Boolean(job.archivedTxId),
      });
    }
  }

  private async writePublication(
    job: JobRecord,
    finalResult: VerificationResultSummaryDto,
    matched: boolean,
    options: { ownsRow: boolean } = { ownsRow: true },
  ): Promise<{ reportUrl: string; reportSha256: string } | undefined> {
    const jobId = job.jobId;

    const verifier = this.configService.get("verifierIdentity", { infer: true });
    const storage = this.buildResultStorage();
    const context = await this.resolveBuildContext(job);
    const { rebuildId, buildMode, mechanismReason, buildEnvironment, chainSourceSha256, buildOptions } = context;
    const canonicalSource = await this.canonicalToPublish(job, storage, context.canonicalSource);
    // The recipe the rebuild ran, not the job's copy of it: that is the one replaying must reproduce.
    const builtOptions = buildOptions ?? job.buildOptions;
    const buildIsolation = toBuildIsolation(buildMode);
    const sourceFileName =
      job.sourceRef.visibility === "public"
        ? await declareSourceFileName(job.sourceRef, this.sourceResolution, canonicalSource)
        : undefined;
    const artifact = assembleArtifact(
      { ...job, buildOptions: builtOptions, result: finalResult },
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
      { jobId, rebuildId, buildMode },
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
        bldarg: toBldarg(builtOptions),
        bldopt: toBldopt(builtOptions),
        sourceSha256: artifact.source.source_sha256,
        sourceUri: job.sourceRef.visibility === "public" ? job.sourceRef.source_uri : undefined,
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
      this.logger.log("re-wrote a published job's objects", {
        job_id: jobId,
        report_sha256: reportSha256,
      });
      return { reportUrl, reportSha256 };
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

    // Only after sources/ is durable: the staging copies may be the only copy of the source.
    if (sourceDurable) {
      await this.stagedSourceRelease.releaseForTerminalJob(job);
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
    staged: StagedSourceLocator,
    canonicalSource?: CanonicalSource,
  ): Promise<boolean> {
    if (job.sourceRef.visibility !== "public") return true;
    if (!job.sourceRef.source_sha256 || !sourceFileName) return false;

    const alreadyPublished = await storage.exists(sourceKeyFromFileName(sourceFileName));
    if (alreadyPublished) return true;

    const source = await readSourceBytesForPublishing(
      job.sourceRef,
      this.sourceResolution,
      staged,
      canonicalSource,
    );
    if (!source.ok) {
      const fields = {
        job_id: jobId,
        rebuild_id: staged.rebuildId,
        source_ref_type: job.sourceRef.type,
        source_file_name: sourceFileName,
        reason: source.reason,
        detail: source.detail,
        ...(source.expectedSha256 ? { expected_sha256: source.expectedSha256 } : {}),
        ...(source.actualSha256 ? { actual_sha256: source.actualSha256 } : {}),
      };
      if (source.reason === "sha256_mismatch") {
        this.logger.error("refusing to publish a source whose staged bytes do not hash to its declared sha256", fields);
      } else {
        this.logger.warn("declared-public source is not available for publishing; sources/ was not written", fields);
      }
      this.metrics.counter("source_publish_unavailable_total", 1, { reason: source.reason });
      return false;
    }
    if (source.sha256 !== sourceSha256FromFileName(sourceFileName)) {
      this.logger.error("refusing to publish a source under a name that does not carry its hash", {
        job_id: jobId,
        source_file_name: sourceFileName,
        source_sha256: source.sha256,
      });
      this.metrics.counter("source_publish_unavailable_total", 1, { reason: "name_hash_disagreement" });
      return false;
    }

    await publishSource(storage, {
      sourceSha256: source.sha256,
      bytes: source.bytes,
      extension: source.extension,
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
    const { rebuildId, buildMode, canonicalSource: rebuildCanonical } = await this.resolveBuildContext(job);
    // The name the job's report already gives its source is the one to publish under, whatever is staged now.
    const reported = await this.reportedSourceFileName(job, storage);
    let canonicalSource: CanonicalSource | undefined;
    if (reported) {
      const canonicalName = rebuildCanonical
        ? await declareSourceFileName(job.sourceRef, this.sourceResolution, rebuildCanonical)
        : undefined;
      canonicalSource = reported === canonicalName ? rebuildCanonical : undefined;
    } else {
      canonicalSource = await this.canonicalToPublish(job, storage, rebuildCanonical);
    }
    const sourceFileName =
      reported ?? (await declareSourceFileName(job.sourceRef, this.sourceResolution, canonicalSource));
    const durable = await this.attemptSourcePublish(
      job,
      storage,
      sourceFileName,
      job.jobId,
      { jobId: job.jobId, rebuildId, buildMode },
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
      await this.stagedSourceRelease.releaseForTerminalJob(job);
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

  async isSourcePublished(sourceFileName: string): Promise<boolean> {
    return this.buildResultStorage().exists(sourceKeyFromFileName(sourceFileName));
  }

  // An instance method so tests can substitute it.
  private buildResultStorage(): ResultStorage {
    return createResultStorage(this.configService.get("resultStorage", { infer: true }));
  }

  /**
   * The canonical archive a public job publishes, while its bytes can still be had: already in `sources/`, or still
   * staged. A done rebuild stays attachable after its staged copies are released (or the scratch bucket expires
   * them); a public job that attaches later publishes its own hash-checked copy instead, under its declared hash,
   * which is the hash of the rebuild's input too, since that hash is part of the rebuild's key.
   */
  private async canonicalToPublish(
    job: JobRecord,
    storage: ResultStorage,
    canonical: CanonicalSource | undefined,
  ): Promise<CanonicalSource | undefined> {
    if (!canonical || job.sourceRef.visibility !== "public") return canonical;
    const name = await declareSourceFileName(job.sourceRef, this.sourceResolution, canonical);
    if (await storage.exists(sourceKeyFromFileName(name))) return canonical;
    try {
      if ((await this.sourceResolution.listStagingKeys(canonical.key)).includes(canonical.key)) return canonical;
    } catch {
      // Unknown is not gone: the name stays canonical, and a publish that cannot read the bytes is retried.
      return canonical;
    }
    this.logger.warn("the rebuild's canonical source archive is gone; publishing the job's own copy under its declared hash", {
      job_id: job.jobId,
      rebuild_id: job.rebuildId,
      canonical_key: canonical.key,
    });
    this.metrics.counter("canonical_source_unavailable_total", 1);
    return undefined;
  }

  /** Whether the report a row points at was written for a private source; false when it cannot be read. */
  private async storedReportIsPrivate(stored: VerificationResultSummaryDto): Promise<boolean> {
    if (!stored.artifact_sha256) return false;
    try {
      const text = await this.buildResultStorage().readText(reportKey(stored.artifact_sha256));
      return text ? (JSON.parse(text) as { source?: { is_public?: unknown } }).source?.is_public === false : false;
    } catch {
      return false;
    }
  }

  /** The source file name the job's published report records, when that report can be read. */
  private async reportedSourceFileName(job: JobRecord, storage: ResultStorage): Promise<string | undefined> {
    const reportSha256 = job.result?.artifact_sha256;
    if (!reportSha256) return undefined;
    try {
      const text = await storage.readText(reportKey(reportSha256));
      const name = text ? (JSON.parse(text) as { source?: { source_file_name?: unknown } }).source?.source_file_name : undefined;
      return typeof name === "string" ? name : undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveBuildContext(job: JobRecord): Promise<{
    rebuildId: string;
    buildMode: BuildMode;
    mechanismReason: MechanismReason;
    buildEnvironment: PublishedBuildEnvironment;
    canonicalSource?: CanonicalSource;
    chainSourceSha256?: string;
    buildOptions?: unknown;
  }> {
    const rebuild = job.rebuildId ? await this.rebuilds.getById(job.rebuildId) : undefined;

    if (!rebuild) {
      throw new Error(`publishJobResult: job ${job.jobId} has no rebuild environment identity.`);
    }

    return {
      rebuildId: rebuild.rebuildId,
      buildMode: rebuild.buildMode ?? "verify",
      mechanismReason: rebuild.mechanismReason,
      buildEnvironment: await this.resolvePublishedBuildEnvironment(rebuild),
      ...(rebuild.canonicalSourceSha256 && rebuild.canonicalSourceKey
        ? { canonicalSource: canonicalSourceOf(rebuild) }
        : {}),
      ...(rebuild.chainSourceSha256 ? { chainSourceSha256: rebuild.chainSourceSha256 } : {}),
      ...(rebuild.buildOptions ? { buildOptions: rebuild.buildOptions } : {}),
    };
  }

  private async resolvePublishedBuildEnvironment(
    rebuild: RebuildRecord,
  ): Promise<PublishedBuildEnvironment> {
    const identity = parseRebuildEnvironmentIdentity(rebuild.imageDigest);
    if (identity.kind === "chain_named") {
      return {
        kind: "chain_named",
        trustLevel: "official_trusted",
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
