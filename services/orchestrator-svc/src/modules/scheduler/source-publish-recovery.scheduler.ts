import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DetachedWork, ScvsLogger, ScvsMetrics, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import { PublishService } from "../publish/index.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class SourcePublishRecoveryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("source-publish-recovery");
  private readonly metrics = new ScvsMetrics("source-publish-recovery", { logger: this.logger });
  private readonly detached = new DetachedWork(this.logger);
  // Same-process, in-flight guard as `ArchiveRecoveryScheduler`'s `retryingJobIds`.
  private readonly retryingJobIds = new Set<string>();

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(PublishService) private readonly publish: PublishService,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "source-publish-recovery",
      this.configService.get("publishRecoveryIntervalMs", { infer: true }),
      () => this.recoverPendingSourcePublishes(),
      this.detached,
    );
    this.detached.start(() => this.recoverPendingSourcePublishes());
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  /**
   * The 24-hour give-up bound lives in `listJobsPendingSourcePublish`'s own query (it excludes rows older than
   * that from what it returns), not here.
   */
  async recoverPendingSourcePublishes(): Promise<void> {
    try {
      const pending = await this.jobs.listJobsPendingSourcePublish(
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      );
      this.metrics.gauge("source_publish_backlog", pending.length);
      for (const job of pending) {
        if (this.retryingJobIds.has(job.jobId)) continue;
        this.retryingJobIds.add(job.jobId);
        this.detached.start(() =>
          this.publish
            .retryPendingSourcePublish(job)
            .catch((error) => {
              this.logger.error("source-publish recovery: failed to retry job", {
                job_id: job.jobId,
                error: error instanceof Error ? error : String(error),
              });
            })
            .finally(() => {
              this.retryingJobIds.delete(job.jobId);
            }),
        );
      }
    } catch (error) {
      this.logger.error("source-publish-recovery scan failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
