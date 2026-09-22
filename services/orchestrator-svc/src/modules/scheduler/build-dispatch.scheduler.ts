import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DrainState, ScvsLogger, ScvsMetrics, runWithLogContext, startInterval, type Network } from "@scvs/core";
import { JobsRepository, type JobRecord } from "@scvs/db";
import { WorkerTickState } from "../../common/worker-tick.module.js";
import { VerificationPipelineService } from "../verification-pipeline/index.js";
import { StartupRecoveryService } from "./startup-recovery.service.js";
import type { AppConfigService } from "../../config/configuration.js";

/** Replaces main.ts's old `setInterval` poll loop with one `@nestjs/schedule` owns. */
@Injectable()
export class BuildDispatchScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("build-dispatch");
  private readonly metrics = new ScvsMetrics("build-dispatch", {
    logger: this.logger,
  });
  private readonly runningJobIds = new Map<string, Network>();
  private polling = false;
  /** Where the next tick starts its slice of `pending` — see `rotateForFairness`. */
  private cursor = 0;

  // Constructor-injecting `StartupRecoveryService` (unused otherwise) makes Nest's lifecycle hook ordering
  // guarantee explicit: its `onModuleInit` (recoverJobsOnStartup) is guaranteed to finish before this class's
  // `onModuleInit` runs, preserving main.ts's old sequential "recover, then start polling" order instead of
  // leaving that to incidental provider order.
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

  // Kick off an immediate poll on cold start so we don't idle a full interval — same as the old code's `void
  // pollOnce()` right after `main()`'s startup logging.
  onModuleInit(): void {
    const intervalMs = this.configService.get("workerPollIntervalMs", { infer: true });
    startInterval(this.schedule, "build-dispatch", intervalMs, () => this.pollOnce());
    this.logger.log("polling @scvs/db for queued jobs", {
      interval_ms: intervalMs,
    });
    void this.pollOnce();
  }

  async pollOnce(): Promise<void> {
    // O9: stop *claiming* while draining. In-flight jobs keep their slice, and a rebuild already dispatched to
    // Batch outlives this process.
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
      // A job now advances one step per tick (attach -> wait for its shared rebuild -> resolve its own
      // verdict), so a job already in `building`/`comparing` still needs ticks to reach a verdict.
      const active = await this.jobs.listJobsByStatus([
        "queued",
        "preparing",
        "building",
        "comparing",
      ]);
      const pending = active.filter((job) => !job.result);
      // O4: emitted on every tick, including the empty one — a gauge that goes silent is indistinguishable from
      // a dead worker, and O5 alarms on *sustained* depth.
      this.metrics.gauge("queue_depth", pending.length);
      this.metrics.gauge("jobs_in_flight", this.runningJobIds.size);
      // Read by `/health/ready` so a probe costs no query — see common/worker-tick.module.ts.
      this.workerTick.record({
        queueDepth: pending.length,
        inFlight: this.runningJobIds.size,
        at: new Date().toISOString(),
      });

      // Only ever logged when there is something to say — this tick runs every couple of seconds.
      if (pending.length > 0) {
        this.logger.log("poll tick", {
          active_jobs: pending.length,
          slots_in_use: this.runningJobIds.size,
          max_concurrency: maxConcurrency,
        });
      }
      // `listJobsByStatus` returns oldest-first, so taking slots from index 0 every tick means the oldest
      // non-terminal job wins EVERY time.
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
        // Entering the scope here — once, around the whole step.
        void runWithLogContext({ job_id: job.jobId }, () =>
          this.pipeline.run(job).finally(() => {
            this.runningJobIds.delete(job.jobId);
          })
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

  /** A derived count, not a second piece of state kept in sync by hand alongside `runningJobIds`. */
  private countRunning(network: Network): number {
    let count = 0;
    for (const n of this.runningJobIds.values()) {
      if (n === network) count++;
    }
    return count;
  }

  /** Rotates `pending` so consecutive ticks start at different jobs, then advances the cursor by one. */
  private rotateForFairness(pending: JobRecord[]): JobRecord[] {
    if (pending.length <= 1) return pending;
    const start = this.cursor % pending.length;
    this.cursor = (start + 1) % pending.length;
    return [...pending.slice(start), ...pending.slice(0, start)];
  }
}
