import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  JobsRepository,
  RebuildsRepository,
  type JobRecord,
  type RebuildRecord,
} from "@scvs/db";
import {
  type BuildMode,
  computeIdempotencyKey,
  type FailureReason,
  isRetryableFailure,
  type JobStatus,
  type LogFields,
  redactAll,
  safeParseDto,
  SandboxDiagnostics as SandboxDiagnosticsDto,
  ScvsLogger,
  ScvsMetrics,
  type SourceReference,
  terminalJobStatuses,
  toWireVerificationStatus,
} from "@scvs/core";
import {
  configurationFailure,
  rebuildFailureDetail,
  rebuildFailureReason,
} from "./failure-reason.util.js";
import {
  ChainReaderService,
  type WasmMetadata,
} from "./chain-reader.service.js";
import { BuildEnvironmentIdentityService } from "./build-environment-identity.service.js";
import { SourceResolutionService } from "../source-resolution/index.js";
import { BatchDispatchService } from "./batch-dispatch.service.js";
import { PublishService } from "../publish/index.js";
import { MismatchDiagnosticsService } from "./mismatch-diagnostics.service.js";
import { selectBuildMechanism } from "./mechanism-routing.util.js";
import { resolveJobVerdict } from "./verdict.util.js";
import type { BuilderInvocationParams } from "./builder-invocation.util.js";
import { builderParams, readRecipeBuildOptions } from "./builder-params.util.js";
import type { AppConfigService } from "../../config/configuration.js";

/**
 * `publish_pending` is deliberately absent: the verdict exists and is never recomputed there, but publication
 * has not finished, so `scheduler/publish-recovery.scheduler.ts` still owns it.
 */
const TERMINAL_STATUSES: readonly JobStatus[] = terminalJobStatuses;

/** `progress.step` while this job's shared rebuild is doing normal, on-time work. */
const BUILDING_STEP = "building";
/** `progress.step` while this job's shared rebuild has gone silent past the reconciliation threshold. */
const STALLED_STEP = "rebuild_stalled";

/**
 * A job does not own a build: it owns a *target* and a verdict about that target, and points at a shared
 * `Rebuild` that may serve many jobs.
 */
@Injectable()
export class VerificationPipelineService {
  private readonly logger = new ScvsLogger("verification-pipeline");
  private readonly metrics = new ScvsMetrics("verification-pipeline", {
    logger: this.logger,
  });

  constructor(
    // The two rebuild-staleness thresholds only.
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(ChainReaderService)
    private readonly chainReader: ChainReaderService,
    @Inject(SourceResolutionService)
    private readonly sourceResolution: SourceResolutionService,
    @Inject(BatchDispatchService)
    private readonly batchDispatch: BatchDispatchService,
    @Inject(PublishService)
    private readonly publish: PublishService,
    // Runs only after a mismatch verdict and cannot change it — see the service's own comment.
    @Inject(MismatchDiagnosticsService)
    private readonly mismatchDiagnostics: MismatchDiagnosticsService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(RebuildsRepository) private readonly rebuilds: RebuildsRepository,
    @Inject(BuildEnvironmentIdentityService)
    private readonly environmentIdentity: BuildEnvironmentIdentityService
  ) {}

  /**
   * Outer entry point — catches anything `process` itself doesn't (e.g. a DB failure while `failJob` tries to
   * record a failure), so a single bad job can't take down the poll loop.
   */
  async run(job: JobRecord): Promise<void> {
    try {
      await this.process(job);
    } catch (error) {
      this.logger.error("job failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  private async process(job: JobRecord): Promise<void> {
    try {
      await this.runJob(job);
    } catch (error) {
      // Deliberately NOT re-queued once the variable lands: these jobs stay failed and are resubmitted, the
      // same way a `policy_rejected` or a failed composition is.
      const misconfigured = configurationFailure(error);
      if (misconfigured) {
        this.logger.error("job failed on a missing configuration value", {
          env_name: misconfigured.envName,
          error: error instanceof Error ? error : String(error),
        });
        await this.failJob(
          job,
          misconfigured.reason,
          misconfigured.reasonCode,
          misconfigured.detail
        );
        return;
      }
      this.logger.error("job crashed", {
        error: error instanceof Error ? error : String(error),
      });
      await this.failJob(
        job,
        "internal_error",
        "worker_exception",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Every step between two status writes is safe to run twice, which is what makes a killed worker cost one
   * tick rather than a wedged row: `preparing` re-runs its validation, `building` re-reads its rebuild,
   * `comparing` re-reads the chain.
   */
  private async runJob(job: JobRecord): Promise<void> {
    // A finished job is finished.
    if (TERMINAL_STATUSES.includes(job.status)) {
      return;
    }

    switch (job.status) {
      case "queued":
        // Exactly one worker wins this; every loser returns and does nothing, and the job is still in the queue
        // for whoever won.
        if (!(await this.jobs.advanceJob(job.jobId, "queued", "preparing"))) {
          return;
        }
        await this.prepare({ ...job, status: "preparing" });
        return;
      case "preparing":
        // A worker died mid-validation. Re-run it — image policy, the chain lookup and find-or-create are all
        // idempotent, and `findOrCreate` returns the row the previous attempt may already have made.
        await this.prepare(job);
        return;
      case "building":
        await this.advanceRebuild(job);
        return;
      case "comparing": {
        // Crashed between the two writes; re-compare against a freshly read chain.
        const rebuild = job.rebuildId
          ? await this.rebuilds.getById(job.rebuildId)
          : undefined;
        if (!rebuild) {
          await this.detachOrphanedJob(job);
          return;
        }
        // Comparing against that produces `matched: false` — a published `mismatched` verdict for a rebuild
        // that has not run.
        if (rebuild.status !== "done" || !rebuild.rebuiltWasmHash) {
          this.logger.warn(
            "rebuild moved back off its terminal state; waiting on it again",
            {
              rebuild_id: rebuild.rebuildId,
              rebuild_status: rebuild.status,
            }
          );
          await this.jobs.advanceJob(job.jobId, "comparing", "building", {
            progress: {
              step: BUILDING_STEP,
              detail: "Waiting on the verifier sandbox rebuild.",
            },
          });
          return;
        }
        await this.compare(job, rebuild);
        return;
      }
      default:
        // `publishing` / `publish_pending` — the publish-recovery scan's, not this loop's.
        return;
    }
  }

  /** Writes a progress line **only when it changes**. */
  private async setProgress(
    job: JobRecord,
    step: string,
    detail: string
  ): Promise<void> {
    if (job.progress?.step === step) return;
    await this.jobs.updateJob(job.jobId, { progress: { step, detail } });
  }

  /**
   * The rebuild row a job points at is gone (the FK is `ON DELETE SET NULL`, so this is recoverable rather than
   * corrupt).
   */
  private async detachOrphanedJob(job: JobRecord): Promise<void> {
    this.logger.warn(
      "attached rebuild no longer exists, re-attaching from scratch",
      {
        rebuild_id: job.rebuildId,
      }
    );
    await this.jobs.advanceJob(
      job.jobId,
      ["preparing", "building", "comparing"],
      "queued",
      {
        // `null`, not `undefined` — Prisma reads `undefined` as "leave this column alone", so the link this
        // method exists to drop would survive.
        rebuildId: null,
      }
    );
  }

  /**
   * `preparing`: validate the target is verifiable at all, then find-or-create the shared rebuild for its
   * recipe and attach to it.
   */
  private async prepare(job: JobRecord): Promise<void> {
    this.logger.log("job picked up", {
      ...this.jobFields(job),
      verification_mode: job.verificationMode,
      source_ref_type: job.sourceRef.type,
    });

    // --- This job's own target resolution. Per-job by nature: two jobs sharing a rebuild have different
    // targets and different deployed hashes.
    await this.setProgress(
      job,
      "chain_lookup",
      "Fetching deployed Wasm and metadata via Stellar CLI."
    );
    const chainLookup = await this.chainReader.getWasmMetadata(job.target);
    if (!chainLookup.ok) {
      // Neither "not_found" nor "chain_lookup_failed" maps cleanly onto the six failure_reason categories (both
      // are about resolving the on-chain *target*, not the build).
      await this.failJob(
        job,
        "internal_error",
        chainLookup.reason,
        chainLookup.detail
      );
      return;
    }

    const expectedHash = job.target.wasm_hash || chainLookup.metadata.wasm_hash;
    if (!expectedHash) {
      await this.failJob(
        job,
        "missing_fields",
        "missing_wasm_hash",
        "Could not determine a Wasm hash for the verification target."
      );
      return;
    }

    // --- Resolve, and if necessary compose, this target's build environment (ADR-017). ------------
    const environmentIdentity = await this.resolveEnvironmentIdentity(
      job,
      chainLookup.metadata
    );
    if (environmentIdentity === undefined) {
      // Either the job was already failed with a reason, or its environment is still composing and this tick
      // has nothing more to do.
      return;
    }

    // --- Find or create the shared rebuild. -------------------------------------------------
    // Keyed off the *persisted* sourceRef, not the resolved one: resolution only fills in `source_uri` (a
    // presigned URL for private uploads), and the key covers the source's content hash, never its location.
    const recipeBuildOptions = readRecipeBuildOptions(
      job.buildOptions,
      chainLookup.metadata.metadata_replay?.entries
    );
    const idempotencyKey = computeIdempotencyKey(
      job.sourceRef,
      environmentIdentity,
      recipeBuildOptions
    );
    // Every input to this is also an input to `idempotencyKey`, so any two jobs that share a rebuild computed
    // the same answer.
    const mechanism = selectBuildMechanism({
      chainRecipe: chainLookup.metadata.sep58,
      rebuildRecipe: recipeBuildOptions,
      environmentIdentity,
    });
    let rebuild = await this.rebuilds.findOrCreate({
      rebuildId: randomUUID(),
      idempotencyKey,
      sourceRef: job.sourceRef,
      buildOptions: recipeBuildOptions,
      imageDigest: environmentIdentity,
      buildMode: mechanism.mode,
      mechanismReason: mechanism.reason,
      ...(chainLookup.metadata.sep58.source_sha256
        ? { chainSourceSha256: chainLookup.metadata.sep58.source_sha256 }
        : {}),
    });
    // Only one direction of disagreement is interesting, and it is not "differs".
    if (mechanism.mode === "build" && rebuild.buildMode === "verify") {
      // Reporting this and dispatching anyway sent the job down a path routing can no longer choose.
      // Reconcilable only while the rebuild is still `pending`; past that its mode records an attempt that
      // really ran, and the log stays the whole answer.
      const reconciled = await this.rebuilds.reconcileBuildMode(
        rebuild.rebuildId,
        mechanism.mode
      );
      this.logger.error(
        "attached to a rebuild set to the CLI path for a recipe PA1 routes to the sandbox",
        {
          rebuild_id: rebuild.rebuildId,
          rebuild_build_mode: rebuild.buildMode,
          this_job_would_use: mechanism.mode,
          reason: mechanism.reason,
          reconciled,
        }
      );
      if (reconciled) rebuild = { ...rebuild, buildMode: mechanism.mode };
    }

    // A job attached earlier and already riding this exact rebuild never comes back through here (it re-enters
    // via the `job.rebuildId` branch in `runJob` instead).
    if (rebuild.status === "done" && rebuild.outcome === "cli_failure") {
      this.logger.warn(
        "rebuild previously exhausted its retry with cli_failure; resetting it for a fresh attempt",
        { rebuild_id: rebuild.rebuildId }
      );
      // Captured before the reset clears it — it is what scopes the re-open to jobs this rebuild failed, rather
      // than jobs that failed for their own target's reasons.
      const staleErrorCode = rebuild.errorCode || "build_failed";
      if (
        await this.rebuilds.requeueStaleCliFailure(
          rebuild.rebuildId,
          mechanism.mode
        )
      ) {
        // Whoever won the reset also owns re-opening the casualties: those jobs' `build_failed` verdicts were
        // correct on the evidence then available, and this attempt is about to produce better evidence about
        // the identical bytes.
        const reopened = await this.jobs.reopenJobsFailedByRebuild(
          rebuild.rebuildId,
          staleErrorCode
        );
        if (reopened.length > 0) {
          this.logger.log("re-opened jobs that had failed on this rebuild", {
            rebuild_id: rebuild.rebuildId,
            error_code: staleErrorCode,
            reopened_count: reopened.length,
            reopened_job_ids: reopened,
          });
        }
      }
      rebuild = (await this.rebuilds.getById(rebuild.rebuildId)) ?? rebuild;
    }

    if (
      !(await this.jobs.advanceJob(job.jobId, "preparing", "building", {
        wasmHash: expectedHash,
        rebuildId: rebuild.rebuildId,
        buildOptions: recipeBuildOptions,
        progress: {
          step: BUILDING_STEP,
          detail: "Waiting on the verifier sandbox rebuild.",
        },
      }))
    ) {
      return;
    }
    this.logger.log("attached to rebuild", {
      expected_wasm_hash: expectedHash,
      rebuild_id: rebuild.rebuildId,
      rebuild_status: rebuild.status,
    });

    // `rowToJob` surfaces the persisted `wasm_hash` column through `target.wasm_hash`, so mirror the update we
    // just wrote there rather than carrying a second field.
    await this.advanceRebuild({
      ...job,
      status: "building",
      target: { ...job.target, wasm_hash: expectedHash },
      rebuildId: rebuild.rebuildId,
    });
  }

  /**
   * Returns the immutable identity the rebuild should be keyed on, or `undefined` when this tick cannot
   * produce one. Which of the two reasons it was is `BuildEnvironmentIdentityService`'s answer; acting on it —
   * failing the job, or saying out loud that it is waiting — is this service's.
   */
  private async resolveEnvironmentIdentity(
    job: JobRecord,
    metadata: WasmMetadata
  ): Promise<string | undefined> {
    await this.setProgress(
      job,
      "resolving_environment",
      "Deriving the build environment from on-chain metadata."
    );

    const outcome = await this.environmentIdentity.resolve(job.jobId, metadata);
    switch (outcome.kind) {
      case "resolved":
        return outcome.identity;
      case "composing":
        await this.setProgress(
          job,
          "composing_environment",
          "Composing the build environment this contract records, from official pinned components."
        );
        return undefined;
      case "failed":
        await this.failJob(
          job,
          outcome.reason,
          outcome.reasonCode,
          outcome.detail
        );
        return undefined;
    }
  }

  /** `building`: one step of progress for a job waiting on the rebuild it is attached to. */
  private async advanceRebuild(job: JobRecord): Promise<void> {
    const rebuild = job.rebuildId
      ? await this.rebuilds.getById(job.rebuildId)
      : undefined;
    if (!rebuild) {
      await this.detachOrphanedJob(job);
      return;
    }
    switch (rebuild.status) {
      case "pending":
        await this.tryDispatch(job, rebuild);
        return;
      case "dispatching":
      case "running":
        // Someone else's Batch job is doing the work; its terminal event will wake every attached job.
        await this.reportRebuildProgress(job, rebuild);
        return;
      case "done":
        await this.settleTerminalRebuild(job, rebuild);
        return;
    }
  }

  /** Keeps this job's reported progress truthful about a rebuild it is only waiting on. */
  private async reportRebuildProgress(
    job: JobRecord,
    rebuild: RebuildRecord
  ): Promise<void> {
    const timeoutMs =
      rebuild.status === "dispatching"
        ? this.configService.get("rebuildDispatchTimeoutMs", { infer: true })
        : this.configService.get("rebuildRunTimeoutMs", { infer: true });
    const silent = Date.now() - Date.parse(rebuild.updatedAt) >= timeoutMs;
    const step = job.progress?.step;

    if (silent && step !== STALLED_STEP) {
      await this.jobs.updateJob(job.jobId, {
        progress: {
          step: STALLED_STEP,
          detail:
            "The verifier sandbox rebuild has not reported back yet. Reconciling it against AWS Batch.",
        },
      });
      this.logger.warn(
        "rebuild is silent; reported as stalled rather than building, the reconciler owns resolving it",
        {
          rebuild_id: rebuild.rebuildId,
          rebuild_status: rebuild.status,
          silent_since: rebuild.updatedAt,
          timeout_minutes: Math.round(timeoutMs / 60_000),
        }
      );
      return;
    }

    if (!silent && step === STALLED_STEP) {
      await this.jobs.updateJob(job.jobId, {
        progress: {
          step: BUILDING_STEP,
          detail: "Waiting on the verifier sandbox rebuild.",
        },
      });
      this.logger.log(
        "rebuild is making progress again, back to reporting a normal rebuild",
        {
          rebuild_id: rebuild.rebuildId,
          rebuild_status: rebuild.status,
        }
      );
    }
  }

  /**
   * Claims the right to dispatch and submits the Batch job. Exactly one job wins the CAS; the rest simply
   * return and wait, which is why this is safe to call from every attached job's tick.
   */
  private async tryDispatch(
    job: JobRecord,
    rebuild: RebuildRecord
  ): Promise<void> {
    if (!(await this.rebuilds.claimForDispatch(rebuild.rebuildId))) {
      this.logger.log("another job is dispatching this rebuild, waiting", {
        rebuild_id: rebuild.rebuildId,
      });
      return;
    }

    // Still read off the row rather than assumed, because rows written before then carry the other value.
    const mode: BuildMode = rebuild.buildMode ?? "build";

    const pinnedHash = job.target.wasm_hash;
    if (!pinnedHash) {
      // Cannot pin bytes for `stellar contract verify`, and the builder refuses `--id` (step 1's TOCTOU fix).
      await this.rebuilds.releaseClaim(rebuild.rebuildId);
      await this.failJob(
        job,
        "missing_fields",
        "missing_wasm_hash",
        "Could not determine a Wasm hash to pin the rebuild against."
      );
      return;
    }

    // Since this resolver, the builder is handed a presigned GET on our own staging bucket for *all* source
    // shapes: a `source_uri` is fetched here, under the destination policy that already governs the
    // publish-time fetch of the same class of URL, and the sandbox makes no request to a host the submitter
    // named.
    const resolved = await this.sourceResolution.resolveSourceRefForDispatch(
      job.sourceRef,
      rebuild.rebuildId,
      mode
    );
    if (!resolved.ok) {
      // Source reachability is a property of the *recipe*, so it would fail identically for every job attached
      // to this rebuild.
      await this.rebuilds.releaseClaim(rebuild.rebuildId);
      await this.failJob(
        job,
        "source_unreachable",
        resolved.reason,
        resolved.detail
      );
      return;
    }

    // Resolve it to the ECR coordinate here, at submit time, and only here.
    const environmentImage = await this.environmentIdentity.resolveImageReference(
      rebuild.imageDigest
    );
    if (!environmentImage) {
      // The environment row backing an already-keyed rebuild has gone missing or been reset.
      await this.rebuilds.releaseClaim(rebuild.rebuildId);
      await this.failJob(
        job,
        "internal_error",
        "environment_not_ready",
        "The composed build environment this rebuild is keyed on is no longer available."
      );
      return;
    }

    const params = builderParams(
      rebuild,
      job,
      resolved.sourceRef,
      pinnedHash,
      environmentImage
    );
    try {
      const batchJobId = await this.batchDispatch.submitBatchJob(params, mode);
      this.logger.log(
        "dispatched to AWS Batch, awaiting its terminal event via SQS",
        {
          rebuild_id: rebuild.rebuildId,
          batch_job_id: batchJobId,
          mode,
          build_isolation:
            mode === "verify" ? "cli_managed" : "network_isolated",
        }
      );
    } catch (error) {
      // Batch rejected the submission. Put the rebuild back in the pool rather than leaving it stuck in
      // `dispatching` until a restart notices, and let the next tick retry.
      await this.rebuilds.releaseClaim(rebuild.rebuildId);
      throw error;
    }
  }

  /** The rebuild is terminal. */
  private async settleTerminalRebuild(
    job: JobRecord,
    rebuild: RebuildRecord
  ): Promise<void> {
    if (rebuild.outcome === "cli_failure") {
      // The sandbox itself couldn't run/finish (tool crash, sandbox unavailable, timeout).
      await this.failJob(
        job,
        rebuildFailureReason(rebuild),
        rebuild.errorCode || "build_failed",
        // Specific when the sandbox positively identified why — currently, a build option the image's CLI
        // rejected, which is otherwise a failure the submitter cannot act on at all.
        rebuildFailureDetail(rebuild)
      );
      return;
    }

    if (!rebuild.rebuiltWasmHash) {
      // Terminal, non-failure, but produced no hash to compare — see publish.service.ts's note on
      // `comparison_not_available`.
      await this.failJob(
        job,
        "internal_error",
        "comparison_not_available",
        "The rebuild completed but reported no rebuilt Wasm hash, so it could not be compared."
      );
      return;
    }

    // The rebuild is finished and produced bytes, so "Waiting on the verifier sandbox rebuild." — written when
    // this job attached — is now false.
    if (
      !(await this.jobs.advanceJob(job.jobId, "building", "comparing", {
        progress: {
          step: "comparing",
          detail:
            "Re-reading the deployed Wasm hash to compare against the rebuild.",
        },
      }))
    ) {
      return;
    }
    await this.compare({ ...job, status: "comparing" }, rebuild);
  }

  /**
   * `comparing`: the trusted side's own comparison of the target's *freshly read* deployed hash against the
   * bytes the rebuild produced, then publication.
   */
  private async compare(job: JobRecord, rebuild: RebuildRecord): Promise<void> {
    // A contract can be upgraded while a rebuild is queued/compiling, and that is exactly what `drifted` below
    // reports.
    const chainLookup = await this.chainReader.getWasmMetadata(job.target);
    if (!chainLookup.ok) {
      // Fail only this job: the rebuild is still perfectly good for every other attached job whose target does
      // resolve.
      await this.failJob(
        job,
        "internal_error",
        chainLookup.reason,
        chainLookup.detail
      );
      return;
    }

    const recordedHash = job.target.wasm_hash;
    // Which hash counts as "current" depends on how the target was identified, and getting this backwards is
    // what makes drift undetectable: contract_id target → whatever the contract points at *now*, straight from
    // the chain.
    const freshDeployedHash = job.target.contract_id
      ? chainLookup.metadata.wasm_hash
      : recordedHash;
    if (!freshDeployedHash) {
      await this.failJob(
        job,
        "missing_fields",
        "missing_wasm_hash",
        "Could not determine the target's current Wasm hash to compare against."
      );
      return;
    }

    const verdict = resolveJobVerdict({
      rebuild,
      freshDeployedHash,
      recordedHash,
    });
    if (verdict.drifted) {
      this.logger.warn(
        "deployed hash moved while the rebuild ran; publishing the byte-level verdict but not the " +
          "by-contract pointer",
        {
          recorded_wasm_hash: recordedHash,
          fresh_deployed_hash: freshDeployedHash,
        }
      );
    }
    this.logger.log("verdict resolved", {
      rebuild_id: rebuild.rebuildId,
      build_mode: rebuild.buildMode ?? "build",
      rebuilt_wasm_hash: rebuild.rebuiltWasmHash,
      deployed_wasm_hash: freshDeployedHash,
      matched: verdict.matched,
    });

    // Placed before adoption deliberately.
    if (job.dryRun) {
      const dryVerdict = verdict.matched ? "verified" : "mismatched";
      const evaluated = await this.jobs.advanceJob(
        job.jobId,
        "comparing",
        "evaluated",
        {
          wasmHash: freshDeployedHash,
          verdict: dryVerdict,
          // `resolveJobVerdict` returns `status_summary: "running"` because `publish.service.ts` is what
          // normally settles it — and a dry run never publishes, so nothing else ever would.
          result: {
            ...verdict.result,
            status_summary: verdict.matched ? "verified" : "mismatch",
          },
          progress: undefined,
        }
      );
      if (!evaluated) return;
      this.logger.log("dry run evaluated; nothing published", {
        rebuild_id: rebuild.rebuildId,
        deployed_wasm_hash: freshDeployedHash,
        matched: verdict.matched,
      });
      this.metrics.counter("verdict_total", 1, {
        verdict: dryVerdict,
        path: "evaluated",
      });
      this.emitJobDuration(job, dryVerdict, "evaluated");
      // Best-effort; deleteStagedUpload never throws.
      await this.sourceResolution.deleteStagedUpload(job.sourceRef);
      return;
    }

    if (await this.adoptPublishedVerdict(job, rebuild, freshDeployedHash)) {
      return;
    }

    // A mismatch is a legitimate final answer, so it has to say *how* the bytes differ — otherwise the least
    // actionable result this service produces is also one of its most common.
    const explained = verdict.matched
      ? undefined
      : await this.mismatchDiagnostics.describe({
          rebuildId: rebuild.rebuildId,
          buildMode: rebuild.buildMode ?? "build",
          runner: rebuild.runner,
          deployedWasmPath: chainLookup.metadata.wasm_path,
          existing: verdict.result.sandbox_diagnostics,
        });
    const result = explained
      ? { ...verdict.result, sandbox_diagnostics: explained }
      : verdict.result;

    // Records the verdict while still holding `comparing`; the move to `publishing` is `publishJobResult`'s
    // claim, so exactly one place acquires a publication.
    if (
      !(await this.jobs.advanceJob(job.jobId, "comparing", "comparing", {
        wasmHash: freshDeployedHash,
        verdict: verdict.matched ? "verified" : "mismatched",
        result,
        // `result` is populated here but its `status_summary` is still the interim "running" — only
        // publish.service.ts settles that to verified/mismatch.
        progress: {
          step: "publishing",
          detail: verdict.matched
            ? "Rebuild matched the deployed bytes. Publishing the verification artifact."
            : "Rebuild did not match the deployed bytes. Publishing the mismatch result.",
        },
      }))
    ) {
      // Another worker has moved this job on. Two publishes mint two artifacts for one claim, so losing here is
      // the correct outcome, not a missed step.
      return;
    }
    try {
      await this.publish.publishJobResult(job.jobId);
    } catch (error) {
      // `recordPublishFailure` has already moved the job to `publish_pending`, which
      // scheduler/publish-recovery.scheduler.ts retries.
      this.logger.error(
        "immediate publish failed, leaving it for the recovery scan",
        {
          error: error instanceof Error ? error : String(error),
        }
      );
      // The progress line and the attempt counter are `PublishService.recordPublishFailure`'s job — it already
      // ran inside the call that threw.
    }
  }


  /** One lookup for both: they differ only in which verdict the prior job carries. */
  private async adoptPublishedVerdict(
    job: JobRecord,
    rebuild: RebuildRecord,
    freshDeployedHash: string
  ): Promise<boolean> {
    const prior = await this.jobs.findPublishedVerdictForRecipe({
      idempotencyKey: rebuild.idempotencyKey,
      wasmHash: freshDeployedHash,
      excludeJobId: job.jobId,
    });
    if (!prior || !prior.verdict || !prior.result) return false;

    const adopted = await this.jobs.advanceJob(
      job.jobId,
      "comparing",
      "published",
      {
        wasmHash: freshDeployedHash,
        verdict: prior.verdict,
        // The prior job's artifact, deliberately: adopting means pointing at the publication that already
        // exists, not minting an identical-but-differently-hashed one beside it.
        result: prior.result,
        progress: undefined,
      }
    );
    if (!adopted) return false;

    this.logger.log(
      "adopted the verdict this recipe already published for these bytes",
      {
        rebuild_id: rebuild.rebuildId,
        wasm_hash: freshDeployedHash,
        verdict: prior.verdict,
        adopted_from_job_id: prior.jobId,
      }
    );
    // Counted as a verdict, on the existing metric rather than a new one: this job did reach a verdict for its
    // target, and leaving it out would understate the verified/mismatched distribution O4 exists to watch.
    this.metrics.counter("verdict_total", 1, {
      verdict: prior.verdict,
      path: "adopted",
    });
    this.emitJobDuration(job, prior.verdict, "adopted");
    // This job's OWN visibility/network can obligate archival the donor never attempted — a `private` donor
    // never ran S3, a `testnet` donor was never Arweave-eligible.
    await this.publish.completeArchiveObligationsForAdoptedJob(job, prior);
    // Best-effort; deleteStagedUpload never throws.
    await this.sourceResolution.deleteStagedUpload(job.sourceRef);
    return true;
  }

  private emitJobDuration(
    job: JobRecord,
    outcome: string,
    path = "unknown"
  ): void {
    const seconds = (Date.now() - Date.parse(job.createdAt)) / 1000;
    this.metrics.histogram("job_duration_seconds", seconds, { outcome, path });
  }

  private jobFields(job: JobRecord): LogFields {
    return {
      network: job.target.network,
      contract_id: job.target.contract_id,
      wasm_hash: job.target.wasm_hash,
    };
  }

  private async failJob(
    job: JobRecord,
    failureReason: FailureReason,
    reasonCode: string,
    detail?: string
  ): Promise<void> {
    this.logger.warn("job failed", {
      failure_reason: failureReason,
      reason_code: reasonCode,
      detail: detail ? redactAll(detail) : undefined,
    });
    // O4: the failure-reason distribution, and the duration of the path that reached it.
    this.metrics.counter("failure_reason_total", 1, {
      reason: failureReason,
      reason_code: reasonCode,
    });
    this.emitJobDuration(job, failureReason);

    // The caller's record is whatever the poll loop loaded at the top of the tick, and `runJob` may have
    // advanced the row since.
    const current = await this.jobs.getJobById(job.jobId);
    if (!current || TERMINAL_STATUSES.includes(current.status)) return;

    // Nothing new is exposed — the success path already serves the whole `sandbox_diagnostics`.
    const stored = current.rebuildId
      ? (await this.rebuilds.getById(current.rebuildId))?.diagnostics
      : undefined;
    const parsed = stored
      ? safeParseDto(SandboxDiagnosticsDto, stored)
      : undefined;
    if (parsed && !parsed.success) {
      // Not silent: an operator losing diagnostics on the one path that needs them should be able to see that
      // they were dropped, and why, rather than infer it from an empty field.
      this.logger.warn(
        "a rebuild's diagnostics did not validate and were not attached to the failure",
        {
          rebuild_id: current.rebuildId,
          reason_code: reasonCode,
        }
      );
    }

    const recorded = await this.jobs.advanceJob(
      current.jobId,
      current.status,
      "failed",
      {
        failureReason,
        error: reasonCode,
        result: {
          status_summary: toWireVerificationStatus("failed", failureReason),
          wasm_hash: job.target.wasm_hash || "unknown",
          reason: reasonCode,
          detail: detail ? redactAll(detail) : undefined,
          verified_at: new Date().toISOString(),
          ...(parsed?.success ? { sandbox_diagnostics: parsed.data } : {}),
        },
        progress: undefined,
      }
    );
    if (!recorded) {
      this.logger.warn(
        "another worker moved this job before the failure could be recorded",
        {
          observed_status: current.status,
        }
      );
      return;
    }
    // The eager delete stays for non-retryable terminals and for a retryable one whose attempts are exhausted.
    const retryStillPossible =
      isRetryableFailure(failureReason) &&
      current.retryAttempts <
        this.configService.get("maxJobRetryAttempts", { infer: true });
    if (retryStillPossible) {
      this.logger.log("staged upload retained for the Rule D retry", {
        job_id: current.jobId,
        retry_attempts: current.retryAttempts,
      });
      return;
    }
    // Best-effort; deleteStagedUpload never throws.
    await this.sourceResolution.deleteStagedUpload(job.sourceRef);
  }
}
