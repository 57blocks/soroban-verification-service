import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DetachedWork, ScvsLogger, ScvsMetrics, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import { ArweaveArchiveService } from "../publish/index.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class StatusLinkRecoveryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("status-link-recovery");
  private readonly metrics = new ScvsMetrics("status-link-recovery", { logger: this.logger });
  private readonly detached = new DetachedWork(this.logger);
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
      this.detached,
    );
    this.detached.start(() => this.recoverPendingStatusLinks());
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  async recoverPendingStatusLinks(): Promise<void> {
    try {
      const pending = await this.jobs.listJobsPendingStatusLink();
      this.metrics.gauge("status_link_backlog", pending.length);
      const oldest = pending[0]?.statusLinkPendingSince;
      this.metrics.gauge(
        "status_link_oldest_pending_seconds",
        oldest ? Math.max(0, (Date.now() - Date.parse(oldest)) / 1000) : 0,
      );

      const blocked = await this.jobs.countJobsBlockedStatusLink();
      for (const reason of ["invalid_document", "unrepresentable", "manual_hold"] as const) {
        this.metrics.gauge("status_link_blocked", blocked.find((row) => row.reason === reason)?.count ?? 0, {
          reason,
        });
      }

      for (const job of pending) {
        if (this.retryingJobIds.has(job.jobId)) continue;
        this.retryingJobIds.add(job.jobId);
        this.detached.start(() =>
          this.arweaveArchive
            .retryPendingStatusLinks(job)
            .catch((error) => {
              this.logger.error("status-link recovery: failed to retry job", {
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
      this.logger.error("status-link recovery tick failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
