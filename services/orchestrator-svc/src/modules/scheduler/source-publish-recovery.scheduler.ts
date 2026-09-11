import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ScvsLogger, ScvsMetrics } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import { PublishService } from "../publish/publish.service.js";

// Reads `process.env` directly rather than through `ConfigService`: `@Interval(...)` is a decorator argument,
// evaluated at class-definition time (module load), before Nest's DI container exists.
const SOURCE_PUBLISH_RECOVERY_INTERVAL_MS = Number(
  process.env.SCVS_PUBLISH_RECOVERY_INTERVAL_MS || 60_000,
);

@Injectable()
export class SourcePublishRecoveryScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("source-publish-recovery");
  private readonly metrics = new ScvsMetrics("source-publish-recovery", { logger: this.logger });
  // Same-process, in-flight guard as `ArchiveRecoveryScheduler`'s `retryingJobIds`.
  private readonly retryingJobIds = new Set<string>();

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(PublishService) private readonly publish: PublishService,
  ) {}

  onModuleInit(): void {
    void this.recoverPendingSourcePublishes();
  }

  /**
   * The 24-hour give-up bound lives in `listJobsPendingSourcePublish`'s own query (it excludes rows older than
   * that from what it returns), not here.
   */
  @Interval(SOURCE_PUBLISH_RECOVERY_INTERVAL_MS)
  async recoverPendingSourcePublishes(): Promise<void> {
    try {
      const pending = await this.jobs.listJobsPendingSourcePublish(
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      );
      this.metrics.gauge("source_publish_backlog", pending.length);
      for (const job of pending) {
        if (this.retryingJobIds.has(job.jobId)) continue;
        this.retryingJobIds.add(job.jobId);
        void this.publish
          .retryPendingSourcePublish(job)
          .catch((error) => {
            this.logger.error("source-publish recovery: failed to retry job", {
              job_id: job.jobId,
              error: error instanceof Error ? error : String(error),
            });
          })
          .finally(() => {
            this.retryingJobIds.delete(job.jobId);
          });
      }
    } catch (error) {
      this.logger.error("source-publish-recovery scan failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
