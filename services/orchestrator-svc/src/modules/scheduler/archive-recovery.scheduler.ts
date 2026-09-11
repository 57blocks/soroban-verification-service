import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ScvsLogger, ScvsMetrics } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import { ArweaveArchiveService } from "../publish/arweave-archive.service.js";

// Low-frequency reconciliation scan (AP4/O7's archive half, archive-and-recovery plan.md Phase 5).
const ARCHIVE_RECOVERY_INTERVAL_MS = Number(process.env.SCVS_ARCHIVE_RECOVERY_INTERVAL_MS || 60_000);

@Injectable()
export class ArchiveRecoveryScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("archive-recovery");
  private readonly metrics = new ScvsMetrics("archive-recovery", { logger: this.logger });
  private readonly retryingJobIds = new Set<string>();

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ArweaveArchiveService) private readonly arweaveArchive: ArweaveArchiveService,
  ) {}

  onModuleInit(): void {
    void this.recoverPendingArchives();
  }

  /**
   * It does not hold *within this same process* across ticks: `retryPendingArchive` is dispatched unawaited
   * below, and this method's own `@Interval` fires again before a large backlog's prior tick is done.
   */
  @Interval(ARCHIVE_RECOVERY_INTERVAL_MS)
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
