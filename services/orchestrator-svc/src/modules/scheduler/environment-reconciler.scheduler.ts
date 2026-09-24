import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DetachedWork, ScvsLogger, ScvsMetrics, startInterval } from "@scvs/core";
import { EnvironmentsRepository, type EnvironmentRecord } from "@scvs/db";
import { ComposerDispatchService } from "../build-environments/index.js";
import { EnvironmentOutcomeService } from "../build-environments/index.js";
import type { AppConfigService } from "../../config/configuration.js";

/** Same sets as the rebuild reconciler — Batch's vocabulary, not ours. */
const BATCH_NON_TERMINAL = new Set(["SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING"]);
const BATCH_TERMINAL = new Set(["SUCCEEDED", "FAILED"]);

/**
 * Unwedges compositions stuck in `composing` — the `Environment` analogue of `RebuildReconcilerScheduler`,
 * necessary for a strictly worse version of the same reason.
 */
@Injectable()
export class EnvironmentReconcilerScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("environment-reconciler");
  private readonly metrics = new ScvsMetrics("environment-reconciler", { logger: this.logger });
  private readonly detached = new DetachedWork(this.logger);
  private reconciling = false;

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(EnvironmentsRepository) private readonly environments: EnvironmentsRepository,
    @Inject(ComposerDispatchService) private readonly composer: ComposerDispatchService,
    @Inject(EnvironmentOutcomeService)
    private readonly outcomes: EnvironmentOutcomeService,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "environment-reconciler",
      this.configService.get("environmentReconcilerIntervalMs", { infer: true }),
      () => this.reconcileStuckEnvironments(),
      this.detached,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  async reconcileStuckEnvironments(): Promise<void> {
    // A scan that outruns its own interval would issue the same resets twice.
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const timeoutMs = this.configService.get("environmentComposeTimeoutMs", { infer: true });
      const stuck = await this.environments.listStuckByStatus(
        "composing",
        new Date(Date.now() - timeoutMs)
      );
      for (const environment of stuck) {
        await this.reconcileOne(environment, timeoutMs);
      }
    } catch (error) {
      // One bad row must not stop the scan from running again next interval.
      this.logger.error("environment reconciliation scan failed", {
        error: error instanceof Error ? error : String(error),
      });
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOne(environment: EnvironmentRecord, timeoutMs: number): Promise<void> {
    const fields = {
      environment_id: environment.environmentId,
      cliver: environment.cliver,
      rsver: environment.rsver,
      template_version: environment.templateVersion,
      silent_since: environment.updatedAt,
      timeout_minutes: Math.round(timeoutMs / 60_000),
    };

    if (!environment.batchJobId) {
      // Claimed, but `markComposing` never recorded a Batch job id — so the submission almost certainly never
      // landed.
      this.logger.warn(
        "composition was claimed but never recorded a Batch job; resetting it to pending",
        fields
      );
      await this.environments.releaseClaim(environment.environmentId);
      return;
    }

    // ── Rung 1: ask Batch ──────────────────────────────────────────────────────────────────────
    let batchState: { status: string; statusReason?: string } | undefined;
    let couldAskBatch = true;
    try {
      batchState = await this.composer.describeBatchJob(environment.batchJobId);
    } catch (error) {
      // Degrade to rung 2 rather than abort — and remember we could not ask, which is what forfeits rung 3.
      couldAskBatch = false;
      this.logger.error("could not ask Batch about a silent composition; trying the receipt", {
        ...fields,
        batch_job_id: environment.batchJobId,
        error: error instanceof Error ? error : String(error),
      });
    }

    if (batchState && BATCH_NON_TERMINAL.has(batchState.status)) {
      // Alive. A composition legitimately takes tens of minutes (a rustup download plus a full `docker build`
      // plus an ECR push), so this is the expected answer for a slow-but-healthy row.
      this.logger.log("composition is still running according to Batch; leaving it alone", {
        ...fields,
        batch_status: batchState.status,
      });
      return;
    }

    if (batchState && BATCH_TERMINAL.has(batchState.status)) {
      this.logger.warn(
        "Batch says this composition is terminal but its event never arrived; resolving it now",
        { ...fields, batch_status: batchState.status }
      );
      await this.outcomes.recordFromBatchTerminalState(environment, batchState);
      return;
    }

    // ── Rung 2: the receipt alone ──────────────────────────────────────────────────────────────
    // Reached when Batch has forgotten the job (`undefined`), reported a status outside both sets, or could not
    // be asked at all.
    if (await this.outcomes.tryRecordFromArtifact(environment)) {
      this.logger.warn("resolved a silent composition from its receipt alone", {
        ...fields,
        batch_status: batchState?.status,
      });
      return;
    }

    // ── Rung 3: reset for a fresh composition ─────────────────────────────────────────────────
    if (!couldAskBatch) {
      // "We could not ask" is not "Batch has no record". Leave it; the next interval may reach Batch.
      this.logger.error(
        "composition is unresolvable this pass (Batch unreachable, no receipt); leaving it untouched",
        { ...fields, batch_job_id: environment.batchJobId }
      );
      return;
    }

    this.logger.warn(
      "no Batch record and no receipt for a silent composition; resetting it to pending for a fresh " +
        "attempt (safe by ADR-017 §4 — nothing is pushed until every checksum verifies)",
      fields
    );
    this.metrics.counter("environment_composition_total", 1, {
      outcome: "timed_out",
      template_version: environment.templateVersion,
    });
    await this.environments.releaseClaim(environment.environmentId);
  }
}
