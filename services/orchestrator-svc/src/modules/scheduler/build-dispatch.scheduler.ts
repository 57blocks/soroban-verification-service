import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DetachedWork, DrainState, ScvsLogger, ScvsMetrics, runWithLogContext, startInterval, type Network } from "@scvs/core";
import { JobsRepository, type JobRecord } from "@scvs/db";
import { WorkerTickState } from "../../common/worker-tick.module.js";
import { VerificationPipelineService } from "../verification-pipeline/index.js";
import { StartupRecoveryService } from "./startup-recovery.service.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class BuildDispatchScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("build-dispatch");
  private readonly metrics = new ScvsMetrics("build-dispatch", {
    logger: this.logger,
  });
  private readonly detached = new DetachedWork(this.logger);
  private readonly runningJobIds = new Map<string, Network>();
  private polling = false;
  private cursor = 0;

  // StartupRecoveryService is injected only so its onModuleInit (recovery) completes before polling starts.
  constructor(
    @Inject(DrainState) private readonly drain: DrainState,
    @Inject(WorkerTickState) private readonly workerTick: WorkerTickState,
    @Inject(StartupRecoveryService)
    private readonly startupRecovery: StartupRecoveryService,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(VerificationPipelineService)
    private readonly pipeline: VerificationPipelineService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.configService.get("workerPollIntervalMs", { infer: true });
    startInterval(this.schedule, "build-dispatch", intervalMs, () => this.pollOnce(), this.detached);
    this.logger.log("polling @scvs/db for queued jobs", {
      interval_ms: intervalMs,
    });
    this.detached.start(() => this.pollOnce());
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  async pollOnce(): Promise<void> {
    if (this.drain.isDraining) return;
    if (this.polling) return;
    this.polling = true;
    try {
      const maxConcurrency = this.configService.get("workerConcurrency", {
        infer: true,
      });
      const testnetConcurrency = this.configService.get(
        "workerConcurrencyTestnet",
        { infer: true }
      );
      if (this.runningJobIds.size >= maxConcurrency) return;
      const active = await this.jobs.listJobsByStatus([
        "queued",
        "preparing",
        "building",
        "comparing",
      ]);
      const pending = active.filter((job) => !job.result);
      // Emitted on every tick, even an empty one: a silent gauge looks like a dead worker.
      this.metrics.gauge("queue_depth", pending.length);
      this.metrics.gauge("jobs_in_flight", this.runningJobIds.size);
      this.workerTick.record({
        queueDepth: pending.length,
        inFlight: this.runningJobIds.size,
        at: new Date().toISOString(),
      });

      if (pending.length > 0) {
        this.logger.log("poll tick", {
          active_jobs: pending.length,
          slots_in_use: this.runningJobIds.size,
          max_concurrency: maxConcurrency,
        });
      }
      const rotated = this.rotateForFairness(pending);
      for (const job of rotated) {
        if (this.runningJobIds.size >= maxConcurrency) {
          this.logger.warn(
            "concurrency limit reached, deferring jobs to a later tick",
            {
              max_concurrency: maxConcurrency,
              deferred: rotated.length - this.runningJobIds.size,
            }
          );
          break;
        }
        if (this.runningJobIds.has(job.jobId)) continue;
        if (
          job.target.network === "testnet" &&
          this.countRunning("testnet") >= testnetConcurrency
        ) {
          this.logger.warn(
            "testnet admission ceiling reached, deferring testnet job to a later tick",
            { testnet_concurrency: testnetConcurrency }
          );
          continue;
        }
        this.runningJobIds.set(job.jobId, job.target.network);
        this.detached.start(() =>
          runWithLogContext({ job_id: job.jobId }, () =>
            this.pipeline.run(job).finally(() => {
              this.runningJobIds.delete(job.jobId);
            })
          )
        );
      }
    } catch (error) {
      this.logger.error("poll tick failed", {
        error: error instanceof Error ? error : String(error),
      });
    } finally {
      this.polling = false;
    }
  }

  private countRunning(network: Network): number {
    let count = 0;
    for (const n of this.runningJobIds.values()) {
      if (n === network) count++;
    }
    return count;
  }

  private rotateForFairness(pending: JobRecord[]): JobRecord[] {
    if (pending.length <= 1) return pending;
    const start = this.cursor % pending.length;
    this.cursor = (start + 1) % pending.length;
    return [...pending.slice(start), ...pending.slice(0, start)];
  }
}
