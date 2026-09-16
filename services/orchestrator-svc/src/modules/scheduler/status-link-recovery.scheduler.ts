import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ScvsLogger, ScvsMetrics } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import { ArweaveArchiveService } from "../publish/arweave-archive.service.js";

// Deliberately unbounded in time, unlike the source-publish scan: that one gives up after 24 hours because
// its input is a staged upload that can be permanently gone, while every input this replay needs — the report
// URL and the tx ids — is durable.
const STATUS_LINK_RECOVERY_INTERVAL_MS = Number(process.env.SCVS_STATUS_LINK_RECOVERY_INTERVAL_MS || 60_000);

@Injectable()
export class StatusLinkRecoveryScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("status-link-recovery");
  private readonly metrics = new ScvsMetrics("status-link-recovery", { logger: this.logger });
  // Same-process, in-flight guard as the sibling recovery schedulers'.
  private readonly retryingJobIds = new Set<string>();

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ArweaveArchiveService) private readonly arweaveArchive: ArweaveArchiveService,
  ) {}

  onModuleInit(): void {
    void this.recoverPendingStatusLinks();
  }

  @Interval(STATUS_LINK_RECOVERY_INTERVAL_MS)
  async recoverPendingStatusLinks(): Promise<void> {
    try {
      const pending = await this.jobs.listJobsPendingStatusLink();
      // Same O4 discipline as the other backlog gauges: emitted on every tick, including the empty one, so
      // silence never reads as zero.
      this.metrics.gauge("status_link_backlog", pending.length);
      // The level alone cannot tell a queue that is moving from one job stuck since the day it published,
      // and the query returns them oldest-first.
      const oldest = pending[0]?.statusLinkPendingSince;
      this.metrics.gauge(
        "status_link_oldest_pending_seconds",
        oldest ? Math.max(0, (Date.now() - Date.parse(oldest)) / 1000) : 0,
      );

      for (const job of pending) {
        if (this.retryingJobIds.has(job.jobId)) continue;
        this.retryingJobIds.add(job.jobId);
        void this.arweaveArchive
          .retryPendingStatusLinks(job)
          .catch((error) => {
            this.logger.error("status-link recovery: failed to retry job", {
              job_id: job.jobId,
              error: error instanceof Error ? error : String(error),
            });
          })
          .finally(() => {
            this.retryingJobIds.delete(job.jobId);
          });
      }
    } catch (error) {
      this.logger.error("status-link recovery tick failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
