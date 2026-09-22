import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { ScvsLogger, startInterval } from "@scvs/core";
import { RebuildsRepository, type RebuildRecord } from "@scvs/db";
import { RebuildOutcomeService } from "../batch-events/rebuild-outcome.service.js";
import { BatchDispatchService } from "../verification-pipeline/batch-dispatch.service.js";
import type { AppConfigService } from "../../config/configuration.js";

/**
 * AWS Batch job states that mean "still working on it". Anything outside this set and outside SUCCEEDED/FAILED
 * is unknown to us and treated as such.
 */
const BATCH_NON_TERMINAL = new Set([
  "SUBMITTED",
  "PENDING",
  "RUNNABLE",
  "STARTING",
  "RUNNING",
]);
const BATCH_TERMINAL = new Set(["SUCCEEDED", "FAILED"]);

/**
 * `advance` treats both `dispatching` and `running` as "wait for someone else's Batch job", with no timeout:
 * correct on the happy path, permanent on a lost event.
 */
@Injectable()
export class RebuildReconcilerScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("rebuild-reconciler");
  private reconciling = false;

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(RebuildsRepository) private readonly rebuilds: RebuildsRepository,
    @Inject(BatchDispatchService) private readonly batch: BatchDispatchService,
    @Inject(RebuildOutcomeService)
    private readonly outcomes: RebuildOutcomeService,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "rebuild-reconciler",
      this.configService.get("rebuildReaperIntervalMs", { infer: true }),
      () => this.reconcileStuckRebuilds(),
    );
  }

  async reconcileStuckRebuilds(): Promise<void> {
    // A scan that outruns its own interval would issue the same resets twice.
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.reapStuckDispatching();
      await this.reconcileStuckRunning();
    } catch (error) {
      this.logger.error("rebuild-reconciler scan failed", {
        error: error instanceof Error ? error : String(error),
      });
    } finally {
      this.reconciling = false;
    }
  }

  private async reapStuckDispatching(): Promise<void> {
    const timeoutMs = this.configService.get("rebuildDispatchTimeoutMs", { infer: true });
    const cutoff = new Date(Date.now() - timeoutMs);
    for (const rebuild of await this.rebuilds.listStuckByStatus("dispatching", cutoff)) {
      // `releaseClaim` is itself a CAS on `dispatching`, so losing to a concurrent recovery or to the claim
      // finally completing is a no-op rather than a corruption.
      await this.rebuilds.releaseClaim(rebuild.rebuildId);
      this.logger.warn('released a rebuild stuck in "dispatching" back to "pending"', {
        rebuild_id: rebuild.rebuildId,
        stuck_since: rebuild.updatedAt,
        timeout_minutes: Math.round(timeoutMs / 60_000),
      });
    }
  }

  private async reconcileStuckRunning(): Promise<void> {
    const timeoutMs = this.configService.get("rebuildRunTimeoutMs", { infer: true });
    const cutoff = new Date(Date.now() - timeoutMs);
    for (const rebuild of await this.rebuilds.listStuckByStatus("running", cutoff)) {
      try {
        await this.reconcileOne(rebuild, timeoutMs);
      } catch (error) {
        // One rebuild's failure must not abandon the rest of the scan, and must NOT be recorded as an outcome —
        // a failed question is not an answer.
        this.logger.error("reconciliation failed, will retry next interval", {
          rebuild_id: rebuild.rebuildId,
          error: error instanceof Error ? error : String(error),
        });
      }
    }
  }

  private async reconcileOne(
    rebuild: RebuildRecord,
    timeoutMs: number
  ): Promise<void> {
    const minutes = Math.round(timeoutMs / 60_000);
    const batchJobId = rebuild.batchJobId;

    // ── Rung 1: ask Batch ──────────────────────────────────────────────────────────────────────
    // Two different things produce no status here, and rung 3 may only act on one of them, so they are tracked
    // apart: Batch *answering* "no such job" is evidence, whereas failing to ask is not.
    let state: { status: string; statusReason?: string } | undefined;
    let batchAnswered = true;
    if (batchJobId) {
      try {
        state = await this.batch.describeBatchJob(batchJobId);
      } catch (error) {
        // A failed question is not an answer — but it is also not a reason to ignore evidence that never went
        // through Batch at all.
        batchAnswered = false;
        this.logger.warn("could not ask Batch about this job, falling through to the build artifact", {
          rebuild_id: rebuild.rebuildId,
          batch_job_id: batchJobId,
          error: error instanceof Error ? error : String(error),
        });
      }
    }

    if (state && BATCH_NON_TERMINAL.has(state.status)) {
      // Alive. Say nothing on the happy path — this runs every interval for every long build.
      return;
    }

    if (state && BATCH_TERMINAL.has(state.status)) {
      this.logger.warn(
        "Batch job is terminal but its event never reached us; resolving from the build artifact",
        {
          rebuild_id: rebuild.rebuildId,
          batch_job_id: batchJobId,
          batch_status: state.status,
          silent_since: rebuild.updatedAt,
          silent_minutes: minutes,
        },
      );
      await this.outcomes.recordFromBatchTerminalState(rebuild, state);
      return;
    }

    // ── Rung 2: Batch has no usable answer; the artifact might ─────────────────────────────────
    // Either Batch answered and had nothing useful (`state === undefined` for a purged/never-submitted job, or
    // a status we don't model), or it could not be asked at all.
    if (await this.outcomes.tryRecordFromArtifact(rebuild)) {
      this.logger.warn("resolved from the build artifact, which outlives Batch's own record", {
        rebuild_id: rebuild.rebuildId,
        batch_job_id: batchJobId,
        batch_answered: batchAnswered,
        batch_status: state?.status,
      });
      return;
    }

    // ── Rung 3: nothing to go on ───────────────────────────────────────────────────────────────
    if (!batchAnswered) {
      // There is no artifact — but Batch was never asked, and rung 3's conclusion rests entirely on Batch
      // having *answered* that it has no record of the job.
      this.logger.error(
        'rebuild is NOT reconcilable and stays "running": Batch could not be asked and the builder ' +
          "uploaded no artifact, so nothing says whether it succeeded. Every attached job stays in " +
          '"comparing" until this clears — check the ECS task role\'s batch:DescribeJobs grant',
        {
          rebuild_id: rebuild.rebuildId,
          batch_job_id: batchJobId,
          silent_since: rebuild.updatedAt,
          silent_minutes: minutes,
        },
      );
      return;
    }

    const reaped = await this.rebuilds.markRunTimedOut(
      rebuild.rebuildId,
      `Batch job ${batchJobId ?? "(unknown)"} never reported a terminal state within ${minutes} minutes, ` +
        `Batch no longer has a record of it, and no build artifact was uploaded.`
    );
    if (!reaped) {
      // The real terminal event landed between the scan and the CAS — its outcome is strictly better than a
      // synthesised timeout, so leaving it alone is the right result.
      this.logger.log(
        "rebuild reported its own terminal state before the reconciler could mark it, leaving it",
        { rebuild_id: rebuild.rebuildId },
      );
      return;
    }
    this.logger.warn(
      "no Batch record and no artifact; marked cli_failure/rebuild_timeout, attached jobs resolve " +
        "on their next poll tick",
      {
        rebuild_id: rebuild.rebuildId,
        batch_job_id: batchJobId,
        silent_since: rebuild.updatedAt,
        silent_minutes: minutes,
      },
    );
  }
}
