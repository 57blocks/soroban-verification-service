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
  mutateWasmStatus,
  publishReport,
  publishSource,
  readLegacyCustody,
  reportKey,
  sourceFileExtension,
  sourceKeyFromFileName,
  sourceSha256FromFileName,
  type ResultStorage,
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
import { buildResultStorage as buildResultStorageFromConfig } from "./result-storage.util.js";
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

  /**
   * The one top-level entry point `batch-events/batch-event-handler.service.ts` and
   * `scheduler/publish-recovery.scheduler.ts` call.
   */
  async publishJobResult(jobId: string): Promise<void> {
    const job = await this.jobs.getJobById(jobId);
    if (!job) {
      throw new Error(`publishJobResult: job ${jobId} not found.`);
    }
    const preliminary = job.result as VerificationResultSummaryDto | undefined;
    if (!preliminary) {
      throw new Error(`publishJobResult: job ${jobId} has no preliminary result to publish.`);
    }

    // Two callers reach this.
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
      // The claim above has already put the row in `publishing`, whichever state the caller found.
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
      // Best-effort; deleteStagedUpload never throws.
      await this.sourceResolution.deleteStagedUpload(job.sourceRef);
      return;
    }

    const matched = preliminary.matched;
    // Same strip `republishStoredResult` does before its own `writePublication` call (RA1/RA2): on a second
    // pass `preliminary` already carries the first publish's own artifact_url/artifact_sha256/arweave_tx_id,
    // which would otherwise hash into a different artifact and defeat findExistingUpload's dedup.
    const { artifact_url: _artifactUrl, artifact_sha256: _artifactSha256, arweave_tx_id: _arweaveTxId, ...priorPublishInput } = preliminary;
    const finalResult: VerificationResultSummaryDto = {
      ...priorPublishInput,
      status_summary: matched ? "verified" : "mismatch",
      verified_at: preliminary.verified_at || new Date().toISOString(),
    };

    try {
      await this.writePublication(job, finalResult, matched);
    } catch (error) {
      // Owning the bookkeeping here.
      await this.recordPublishFailure(job, error);
      // Rethrown so callers still log and treat it as failed; only the *accounting* moved in here.
      throw error;
    }
  }

  /** Re-writes one already-published job's objects into result storage **without touching the row**. */
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

  /** Everything that touches result storage. Isolated so exactly one `catch` counts an attempt. */
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

    // The ordering constraint above is relative to `advanceJob`/`deleteStagedUpload`, not to this write.
    const sourceDurable = await this.attemptSourcePublish(
      job,
      storage,
      sourceFileName,
      jobId,
      canonicalSource,
    );
    // The submitter-facing URL for the copy `sources/` just confirmed durable — our own storage's copy.
    const verifiedSourceCodeUri: RegistrySourceCodeUri | undefined =
      sourceDurable && sourceFileName
        ? { location: "verifier_self_storage", url: verifiedSourceCodeUrl(storage, sourceFileName) }
        : undefined;

    // Scheduling this earlier would race `appendVerifiedSourceCodeUri`'s own "is this still the current entry"
    // check against a wasms/<hash>.json that may not exist yet on this job's first publish.
    const sourceArchiveEligible = this.isSourceArchiveEligible(job, sourceDurable, sourceFileName);

    // wasms/<hash>.json — the Registry API status object (report-artifact plan.md phase 3).
    const thisVerdict = matched ? "verified" : "mismatched";
    // Our entry by verifier identity (the result root is the key, AU2) — never by array position, so a document
    // carrying another verifier's entry is left intact.
    const ownIdentity = { name: verifier.displayName, url: storage.publicRoot };
    // Rule 20 is decided inside the mutation, against bytes read in the same compare-and-swap that writes
    // them. Deciding it out here — as this did — reads a snapshot another replica can invalidate before the
    // write lands, which is how a `mismatched` displaces a `verified`.
    const statusOutcome = await mutateWasmStatus(storage, finalResult.wasm_hash, (existing) => {
      const build = buildWasmStatus({
        existing,
        wasmHash: finalResult.wasm_hash,
        verifier: ownIdentity,
        verdict: thisVerdict,
        recipeSource: artifact.provenance.recipe_source,
        imageTrustLevel: buildEnvironment.trustLevel,
        bldimg: buildEnvironment.buildImage,
        // SEP-58 v0.6.0: order-significant, passed through as recorded.
        bldarg: toBldarg(job.buildOptions),
        bldopt: toBldopt(job.buildOptions),
        // artifact.source.source_sha256 is already the invariant-checked value (assembleArtifact's
        // requireSourceSha256) — reusing it means this call site does not need its own copy of that check.
        sourceSha256: artifact.source.source_sha256,
        sourceUri: job.sourceRef.source_uri,
        ...(matched ? {} : { rebuiltHash: finalResult.rebuilt_wasm_hash }),
        processedAt: now,
        // AU1: the report link carries the hash of the exact bytes just written. Our own storage's copy.
        resultsUrls: [{ type: "report", location: "verifier_self_storage", url: reportUrl, sha256: reportSha256 }],
        ...(verifiedSourceCodeUri ? { verifiedSourceCodeUris: [verifiedSourceCodeUri] } : {}),
      });
      return build.outcome === "write" ? { write: build.document } : { skip: "superseded" };
    });
    // This job has not published yet, so an unlanded write is not a link obligation — it is a failed
    // publication. Throwing leaves the row in `publishing` for `releaseStalePublishing` to return to
    // `publish_pending`, and `recordPublishFailure` counts the attempt.
    if (statusOutcome !== "written" && statusOutcome !== "superseded") {
      throw new Error(
        `publishJobResult: job ${jobId} could not write wasms/${finalResult.wasm_hash}.json (${statusOutcome})`,
      );
    }
    const wasmStatusChanged = statusOutcome === "written";

    // policy.json is no longer written here: it is this verifier's own identity/policy information, unrelated
    // to any one job's outcome, so it is written once at process startup by VerifierIdentityPublisher
    // (result-storage.util.ts is what both share) rather than re-derived on every publish.

    if (!options.ownsRow) {
      this.logger.log("re-wrote a published job's objects; the row was already correct", {
        job_id: jobId,
        report_sha256: reportSha256,
      });
      return;
    }

    const recorded = await this.jobs.advanceJob(jobId, "publishing", "published", {
      // Both outcomes are `published` now; which one it was lives in `verdict`.
      verdict: thisVerdict,
      result: { ...finalResult, artifact_url: reportUrl, artifact_sha256: reportSha256 },
      progress: undefined,
      // If the process dies on the next line, the row already durably says "an archive is pending since T".
      archivePendingSince: new Date(now),
      // Set here on first publish; ArweaveArchiveService advances it again on a real archive-backfill write
      // (see `recordArchiveOutcome`).
      ...(wasmStatusChanged ? { publishedUpdatedAt: new Date(now) } : {}),
      // `null` for every other case — either there was nothing to publish, or this attempt already succeeded —
      // so the recovery scheduler's query never sees a row with nothing left to do.
      ...(job.sourceRef.visibility === "public"
        ? { sourcePublishPendingSince: sourceDurable ? null : new Date(now) }
        : {}),
      // mainnet-source-archive design.md MSA-2: the durable pending flag for THIS job's own source-archive
      // obligation, set alongside archivePendingSince's own timing.
      ...(sourceArchiveEligible ? { sourceArchivePendingSince: new Date(now) } : {}),
    });

    // Every S3 write above has already happened.
    if (!recorded) {
      throw new Error(
        `publishJobResult: job ${jobId} left "publishing" while its result was being written; ` +
          "another worker owns this publication.",
      );
    }

    // Only for a public job; a private one has nothing to publish.
    if (job.sourceRef.visibility === "public") {
      try {
        await this.jobs.recordSourcePublishOutcome(
          jobId,
          sourceDurable && sourceFileName
            // The status object written moments ago already carries this URI (`verifiedSourceCodeUri` went
            // into `buildWasmStatus`), so there is nothing for the link scan to do.
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

    // Best-effort; deleteStagedUpload never throws. Runs after the sources/ write above, so a crash here never
    // loses the only copy of a publicly-declared source.
    if (sourceDurable) {
      await this.sourceResolution.deleteStagedUpload(job.sourceRef);
    }

    // Archive backfill: appends a fetchable Irys gateway URL to wasms/<hash>.json's own results_urls
    // (registry-status-object's document), never the report artifact itself (RA2, AP2).
    this.arweaveArchive.scheduleArweaveBackfill({
      jobId,
      storage,
      wasmHash: finalResult.wasm_hash,
      reportUrl,
      reportSha256,
      reportBytes,
      verifierId: verifier.id,
    });

    // mainnet-source-archive design.md MSA-1: schedules the actual upload now that wasms/<hash>.json exists
    // (written above).
    if (sourceArchiveEligible) {
      await this.maybeScheduleSourceArchive(job, storage, sourceFileName, reportUrl);
    }
    this.logger.log("published", {
      job_id: jobId,
      outcome: thisVerdict,
      report_url: reportUrl,
    });

    // O4. Kept so those rows still publish the path that actually ran.
    const path = buildMode === "verify" ? "cli" : "independent";
    this.metrics.counter("verdict_total", 1, { verdict: thisVerdict, path });
    this.metrics.histogram(
      "job_duration_seconds",
      (Date.now() - Date.parse(job.createdAt)) / 1000,
      { outcome: thisVerdict, path },
    );
  }

  /** Writes `sources/{sha256}{extension}` for a declared-public job, or confirms it is already there. */
  private async attemptSourcePublish(
    job: JobRecord,
    storage: ResultStorage,
    sourceFileName: string | undefined,
    jobId: string,
    canonicalSource?: CanonicalSource,
  ): Promise<boolean> {
    if (job.sourceRef.visibility !== "public") return true; // nothing to publish
    if (!job.sourceRef.source_sha256 || !sourceFileName) return false;

    const alreadyPublished = await storage.exists(sourceKeyFromFileName(sourceFileName));
    if (alreadyPublished) return true;

    const fetched = await fetchSourceBytesForPublishing(
      job.sourceRef,
      this.sourceResolution,
      canonicalSource,
    );
    if (!fetched) {
      // Silent by design in `fetchSourceBytesForPublishing` itself (never throws), but silent all the way to
      // the logs is a real gap this closes: without this, a declared-public source that never made it into
      // `sources/` leaves no trace anywhere an operator could find it.
      this.logger.warn("declared-public source could not be fetched for publishing; sources/ was not written", {
        job_id: jobId,
        source_ref_type: job.sourceRef.type,
        source_sha256: job.sourceRef.source_sha256,
        source_file_name: sourceFileName,
      });
      return false;
    }

    // `fetched.extension` and `sourceFileName`'s extension can disagree only if the filename/URL genuinely
    // changed between the two calls (e.g. an edited upload row).
    await publishSource(storage, {
      // The canonical archive's hash when there is one: `sourceFileName` was built from it, and `E2E-SRC-06`
      // asserts that hashing the bytes at that key reproduces `source.source_sha256`.
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

  /** Reads the just-published source bytes back and schedules the Arweave upload. */
  private async maybeScheduleSourceArchive(
    job: JobRecord,
    storage: ResultStorage,
    sourceFileName: string | undefined,
    reportUrl: string,
  ): Promise<void> {
    const sourceBytes = await storage.readBytes(sourceKeyFromFileName(sourceFileName!));
    if (!sourceBytes) {
      // Just-written key unreadable.
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

  /** `job` must already have `sourcePublishPendingSince` set, i.e. come from `listJobsPendingSourcePublish`. */
  async retryPendingSourcePublish(job: JobRecord): Promise<void> {
    if (job.sourceRef.visibility !== "public") {
      // A bug elsewhere, not a case to paper over: `sourcePublishPendingSince` is only ever set for a public
      // job (writePublication's own gate above).
      this.logger.error(`job ${job.jobId}: pending source publish but sourceRef is not public — skipping`);
      return;
    }
    const storage = this.buildResultStorage();
    // Resolved the same way the live path resolves it, from the same row.
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

    // mainnet-source-archive design.md MSA-3: a delayed source-publish success can make a mainnet+public job
    // archive-eligible for the first time.
    const sourceArchiveEligible =
      !!job.result?.artifact_url && this.isSourceArchiveEligible(job, durable, sourceFileName);

    await this.jobs.recordSourcePublishOutcome(
      job.jobId,
      durable
        ? {
            published: true,
            sourceFileName,
            // This job's document was written before the source landed, so its URI is not in it yet.
            owesStatusLink: true,
            ...(sourceArchiveEligible ? { sourceArchivePendingSince: new Date() } : {}),
          }
        : { published: false },
    );
    if (durable) {
      await this.sourceResolution.deleteStagedUpload(job.sourceRef);
      if (sourceFileName) {
        // The full recompute, not a lone append: `recordSourcePublishOutcome` above wrote the link
        // obligation in the same statement that discharged the source-publish one, and only a pass that
        // rebuilds every link this row owes may discharge it in turn.
        await this.arweaveArchive.retryPendingStatusLinks({ ...job, sourceFileName });
        // wasms/<hash>.json already exists by construction on this retry path (this job already published
        // once), so.
        if (sourceArchiveEligible) {
          await this.maybeScheduleSourceArchive(job, storage, sourceFileName, job.result!.artifact_url!);
        }
      }
    }
  }

  /**
   * `adoptPublishedVerdict`'s archive step: an adopting job's own `visibility`/`network` can obligate archival
   * its donor never attempted.
   */
  async completeArchiveObligationsForAdoptedJob(job: JobRecord, prior: JobRecord): Promise<void> {
    if (job.sourceRef.visibility !== "public") return; // nothing either tier can do
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

  /**
   * Counts a failed publication and reports it to the submitter through `progress`, so "we are retrying, and
   * this is attempt N" is *visible*.
   */
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

    // Best-effort: this runs on a path that is already failing, and letting it throw would replace a publish
    // error with a database error in the caller's `catch`, losing the real cause.
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

  /** A thin wrapper over the shared `buildResultStorage` (result-storage.util.ts), kept as an instance method. */
  private buildResultStorage(): ResultStorage {
    return buildResultStorageFromConfig(this.configService.get("resultStorage", { infer: true }));
  }

  /** Resolves both RA4's isolation and the environment evidence from the shared Rebuild. */
  private async resolveBuildContext(job: JobRecord): Promise<{
    buildMode: BuildMode;
    mechanismReason: MechanismReason;
    buildEnvironment: PublishedBuildEnvironment;
    canonicalSource?: CanonicalSource;
    chainSourceSha256?: string;
  }> {
    const rebuild = job.rebuildId ? await this.rebuilds.getById(job.rebuildId) : undefined;

    // Confirmed no row in dev or staging ever matched its condition (`verification_mode = 'metadata' AND
    // rebuild_id IS NULL`).
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

/** The submitter-facing URL for a `sources/{sha}{extension}` object this ResultStorage's public root serves. */
function verifiedSourceCodeUrl(storage: ResultStorage, sourceFileName: string): string {
  return `${storage.publicRoot}/${sourceKeyFromFileName(sourceFileName)}`;
}

/** The `Rebuild` row's canonical-source facts, as publish consumes them. */
function canonicalSourceOf(rebuild: RebuildRecord): CanonicalSource {
  const record = rebuild.sourceCanonicalisation as { canonical_format?: string } | undefined;
  return {
    sha256: rebuild.canonicalSourceSha256!,
    key: rebuild.canonicalSourceKey!,
    ...(record?.canonical_format ? { format: record.canonical_format } : {}),
  };
}
