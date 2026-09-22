import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { ScvsLogger, ScvsMetrics, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import { ArweaveArchiveService } from "../publish/index.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class ArchiveRecoveryScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("archive-recovery");
  private readonly metrics = new ScvsMetrics("archive-recovery", { logger: this.logger });
  private readonly retryingJobIds = new Set<string>();

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ArweaveArchiveService) private readonly arweaveArchive: ArweaveArchiveService,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "archive-recovery",
      this.configService.get("archiveRecoveryIntervalMs", { infer: true }),
      () => this.recoverPendingArchives(),
    );
    void this.recoverPendingArchives();
  }

  /**
   * It does not hold *within this same process* across ticks: `retryPendingArchive` is dispatched unawaited
   * below, and this method's own interval fires again before a large backlog's prior tick is done.
   */
  async recoverPendingArchives(): Promise<void> {
    try {
      const pending = await this.jobs.listJobsPendingArchive();
      this.metrics.gauge("archive_backlog", pending.length);
      for (const job of pending) {
        if (this.retryingJobIds.has(job.jobId)) continue;
        this.retryingJobIds.add(job.jobId);
        void this.arweaveArchive
          .retryPendingArchive(job)
          .catch((error) => {
            this.logger.error("archive recovery: failed to retry job", {
              job_id: job.jobId,
              error: error instanceof Error ? error : String(error),
            });
          })
          .finally(() => {
            this.retryingJobIds.delete(job.jobId);
          });
      }
    } catch (error) {
      this.logger.error("archive-recovery scan failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
