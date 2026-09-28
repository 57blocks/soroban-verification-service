import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DetachedWork, DrainState, RETRY_ELIGIBILITY_WINDOW_MS, ScvsLogger, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import type { AppConfigService } from "../../config/configuration.js";

const ELIGIBILITY_WINDOW_MS = RETRY_ELIGIBILITY_WINDOW_MS;

const LOGGED_ID_LIMIT = 20;

@Injectable()
export class JobRetryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("job-retry");
  private readonly detached = new DetachedWork(this.logger);

  constructor(
    @Inject(DrainState) private readonly drain: DrainState,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "job-retry",
      this.configService.get("jobRetryIntervalMs", { infer: true }),
      () => this.requeueRetryable(),
      this.detached,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  async requeueRetryable(): Promise<void> {
    if (this.drain.isDraining) return;
    try {
      const maxAttempts = this.configService.get("maxJobRetryAttempts", { infer: true });
      const requeued = await this.jobs.requeueRetryableFailures(
        maxAttempts,
        new Date(Date.now() - ELIGIBILITY_WINDOW_MS),
      );
      if (requeued.length > 0) {
        this.logger.warn("re-queued jobs that failed for a retryable reason", {
          count: requeued.length,
          job_ids: requeued.slice(0, LOGGED_ID_LIMIT),
          max_attempts: maxAttempts,
        });
      }
    } catch (error) {
      this.logger.error("job-retry scan failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
