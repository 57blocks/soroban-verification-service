import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { ScvsLogger, ScvsMetrics, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import { ArweaveArchiveService } from "../publish/arweave-archive.service.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class StatusLinkRecoveryScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("status-link-recovery");
  private readonly metrics = new ScvsMetrics("status-link-recovery", { logger: this.logger });
  // Same-process, in-flight guard as the sibling recovery schedulers'.
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
      "status-link-recovery",
      this.configService.get("statusLinkRecoveryIntervalMs", { infer: true }),
      () => this.recoverPendingStatusLinks(),
    );
    void this.recoverPendingStatusLinks();
  }

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

      // Held rows are excluded from `pending` by construction, so without this the one state that needs a
      // human is the one nothing reports.
      const blocked = await this.jobs.countJobsBlockedStatusLink();
      for (const reason of ["invalid_document", "unrepresentable", "manual_hold"] as const) {
        this.metrics.gauge("status_link_blocked", blocked.find((row) => row.reason === reason)?.count ?? 0, {
          reason,
        });
      }

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
