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

const TERMINAL_STATUSES: readonly JobStatus[] = terminalJobStatuses;

const BUILDING_STEP = "building";
const STALLED_STEP = "rebuild_stalled";

@Injectable()
export class VerificationPipelineService {
  private readonly logger = new ScvsLogger("verification-pipeline");
  private readonly metrics = new ScvsMetrics("verification-pipeline", {
    logger: this.logger,
  });

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(ChainReaderService)
    private readonly chainReader: ChainReaderService,
    @Inject(SourceResolutionService)
    private readonly sourceResolution: SourceResolutionService,
    @Inject(BatchDispatchService)
    private readonly batchDispatch: BatchDispatchService,
    @Inject(PublishService)
    private readonly publish: PublishService,
    @Inject(MismatchDiagnosticsService)
    private readonly mismatchDiagnostics: MismatchDiagnosticsService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(RebuildsRepository) private readonly rebuilds: RebuildsRepository,
    @Inject(BuildEnvironmentIdentityService)
    private readonly environmentIdentity: BuildEnvironmentIdentityService
  ) {}

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

  private async runJob(job: JobRecord): Promise<void> {
    if (TERMINAL_STATUSES.includes(job.status)) {
      return;
    }

    switch (job.status) {
      case "queued":
        if (!(await this.jobs.advanceJob(job.jobId, "queued", "preparing"))) {
          return;
        }
        await this.prepare({ ...job, status: "preparing" });
        return;
      case "preparing":
        await this.prepare(job);
        return;
      case "building":
        await this.advanceRebuild(job);
        return;
      case "comparing": {
        const rebuild = job.rebuildId
          ? await this.rebuilds.getById(job.rebuildId)
          : undefined;
        if (!rebuild) {
          await this.detachOrphanedJob(job);
          return;
        }
        // A rebuild that is not done would compare as a false mismatch.
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
        return;
    }
  }

  private async setProgress(
    job: JobRecord,
    step: string,
    detail: string
  ): Promise<void> {
    if (job.progress?.step === step) return;
    await this.jobs.updateJob(job.jobId, { progress: { step, detail } });
  }

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
        // null, not undefined: Prisma reads undefined as "leave this column alone".
        rebuildId: null,
      }
    );
  }

  private async prepare(job: JobRecord): Promise<void> {
    this.logger.log("job picked up", {
      ...this.jobFields(job),
      verification_mode: job.verificationMode,
      source_ref_type: job.sourceRef.type,
    });

    await this.setProgress(
      job,
      "chain_lookup",
      "Fetching deployed Wasm and metadata via Stellar CLI."
    );
    const chainLookup = await this.chainReader.getWasmMetadata(job.target);
    if (!chainLookup.ok) {
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

    const environmentIdentity = await this.resolveEnvironmentIdentity(
      job,
      chainLookup.metadata
    );
    if (environmentIdentity === undefined) {
      return;
    }

    // Keyed off the persisted sourceRef: the key covers the source's content hash, never its location.
    const recipeBuildOptions = readRecipeBuildOptions(
      job.buildOptions,
      chainLookup.metadata.metadata_replay?.entries
    );
    const idempotencyKey = computeIdempotencyKey(
      job.sourceRef,
      environmentIdentity,
      recipeBuildOptions
    );
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
    if (mechanism.mode === "build" && rebuild.buildMode === "verify") {
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

    if (rebuild.status === "done" && rebuild.outcome === "cli_failure") {
      this.logger.warn(
        "rebuild previously exhausted its retry with cli_failure; resetting it for a fresh attempt",
        { rebuild_id: rebuild.rebuildId }
      );
      // Captured before the reset clears it.
      const staleErrorCode = rebuild.errorCode || "build_failed";
      if (
        await this.rebuilds.requeueStaleCliFailure(
          rebuild.rebuildId,
          mechanism.mode
        )
      ) {
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

    await this.advanceRebuild({
      ...job,
      status: "building",
      target: { ...job.target, wasm_hash: expectedHash },
      rebuildId: rebuild.rebuildId,
    });
  }

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
        await this.reportRebuildProgress(job, rebuild);
        return;
      case "done":
        await this.settleTerminalRebuild(job, rebuild);
        return;
    }
  }

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

    const mode: BuildMode = rebuild.buildMode ?? "build";

    const pinnedHash = job.target.wasm_hash;
    if (!pinnedHash) {
      await this.rebuilds.releaseClaim(rebuild.rebuildId);
      await this.failJob(
        job,
        "missing_fields",
        "missing_wasm_hash",
        "Could not determine a Wasm hash to pin the rebuild against."
      );
      return;
    }

    const resolved = await this.sourceResolution.resolveSourceRefForDispatch(
      job.sourceRef,
      rebuild.rebuildId,
      mode
    );
    if (!resolved.ok) {
      await this.rebuilds.releaseClaim(rebuild.rebuildId);
      await this.failJob(
        job,
        "source_unreachable",
        resolved.reason,
        resolved.detail
      );
      return;
    }

    const environmentImage = await this.environmentIdentity.resolveImageReference(
      rebuild.imageDigest
    );
    if (!environmentImage) {
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
      await this.rebuilds.releaseClaim(rebuild.rebuildId);
      throw error;
    }
  }

  private async settleTerminalRebuild(
    job: JobRecord,
    rebuild: RebuildRecord
  ): Promise<void> {
    if (rebuild.outcome === "cli_failure") {
      await this.failJob(
        job,
        rebuildFailureReason(rebuild),
        rebuild.errorCode || "build_failed",
        rebuildFailureDetail(rebuild)
      );
      return;
    }

    if (!rebuild.rebuiltWasmHash) {
      await this.failJob(
        job,
        "internal_error",
        "comparison_not_available",
        "The rebuild completed but reported no rebuilt Wasm hash, so it could not be compared."
      );
      return;
    }

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

  private async compare(job: JobRecord, rebuild: RebuildRecord): Promise<void> {
    const chainLookup = await this.chainReader.getWasmMetadata(job.target);
    if (!chainLookup.ok) {
      await this.failJob(
        job,
        "internal_error",
        chainLookup.reason,
        chainLookup.detail
      );
      return;
    }

    const recordedHash = job.target.wasm_hash;
    // A contract_id target compares against the chain's current hash; the recorded one would hide drift.
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

    if (job.dryRun) {
      const dryVerdict = verdict.matched ? "verified" : "mismatched";
      const evaluated = await this.jobs.advanceJob(
        job.jobId,
        "comparing",
        "evaluated",
        {
          wasmHash: freshDeployedHash,
          verdict: dryVerdict,
          // A dry run never publishes, so status_summary is settled here.
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
      await this.sourceResolution.deleteStagedUpload(job.sourceRef);
      return;
    }

    if (await this.adoptPublishedVerdict(job, rebuild, freshDeployedHash)) {
      return;
    }

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

    if (
      !(await this.jobs.advanceJob(job.jobId, "comparing", "comparing", {
        wasmHash: freshDeployedHash,
        verdict: verdict.matched ? "verified" : "mismatched",
        result,
        progress: {
          step: "publishing",
          detail: verdict.matched
            ? "Rebuild matched the deployed bytes. Publishing the verification artifact."
            : "Rebuild did not match the deployed bytes. Publishing the mismatch result.",
        },
      }))
    ) {
      return;
    }
    try {
      await this.publish.publishJobResult(job.jobId);
    } catch (error) {
      this.logger.error(
        "immediate publish failed, leaving it for the recovery scan",
        {
          error: error instanceof Error ? error : String(error),
        }
      );
    }
  }


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
    this.metrics.counter("verdict_total", 1, {
      verdict: prior.verdict,
      path: "adopted",
    });
    this.emitJobDuration(job, prior.verdict, "adopted");
    await this.publish.completeArchiveObligationsForAdoptedJob(job, prior);
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
    this.metrics.counter("failure_reason_total", 1, {
      reason: failureReason,
      reason_code: reasonCode,
    });
    this.emitJobDuration(job, failureReason);

    const current = await this.jobs.getJobById(job.jobId);
    if (!current || TERMINAL_STATUSES.includes(current.status)) return;

    const stored = current.rebuildId
      ? (await this.rebuilds.getById(current.rebuildId))?.diagnostics
      : undefined;
    const parsed = stored
      ? safeParseDto(SandboxDiagnosticsDto, stored)
      : undefined;
    if (parsed && !parsed.success) {
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
    await this.sourceResolution.deleteStagedUpload(job.sourceRef);
  }
}
