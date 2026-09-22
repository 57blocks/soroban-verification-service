import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { ScvsLogger, ScvsMetrics, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import type { AppConfigService } from "../../config/configuration.js";
import { ArweaveArchiveService } from "../publish/arweave-archive.service.js";

@Injectable()
export class SourceArchiveRecoveryScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("source-archive-recovery");
  private readonly metrics = new ScvsMetrics("source-archive-recovery", { logger: this.logger });
  // Same-process, in-flight guard as `ArchiveRecoveryScheduler`'s `retryingJobIds`.
  private readonly retryingJobIds = new Set<string>();

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ArweaveArchiveService) private readonly arweaveArchive: ArweaveArchiveService,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "source-archive-recovery",
      this.configService.get("archiveRecoveryIntervalMs", { infer: true }),
      () => this.recoverPendingSourceArchives(),
    );
    const config = this.configService.get("arweave", { infer: true });
    if (config.sourceArchiveEnabled && config.mode === "disabled") {
      this.logger.warn(
        "SCVS_SOURCE_ARCHIVE_ENABLED is true but SCVS_ARWEAVE_MODE is 'disabled' — every eligible job will sit " +
          "pending and be retried here indefinitely, since the upload itself can never succeed",
      );
    }
    void this.recoverPendingSourceArchives();
  }

  async recoverPendingSourceArchives(): Promise<void> {
    try {
      const pending = await this.jobs.listJobsPendingSourceArchive();
      // Same O4 discipline as archive_backlog/source_publish_backlog: emitted on every tick, including the
      // empty one.
      this.metrics.gauge("source_archive_backlog", pending.length);
      // Mirrors the eligibility gate at schedule time (mainnet-source-archive design.md §8, MSA-5): when
      // archiving is off, existing pending rows are left alone (no data loss) but never retried — retrying
      // them would just repeat the arweave_disabled failure this flag exists to stop.
      if (!this.configService.get("arweave", { infer: true }).sourceArchiveEnabled) return;
      for (const job of pending) {
        if (this.retryingJobIds.has(job.jobId)) continue;
        this.retryingJobIds.add(job.jobId);
        void this.arweaveArchive
          .retryPendingSourceArchive(job)
          .catch((error) => {
            this.logger.error("source-archive recovery: failed to retry job", {
              job_id: job.jobId,
              error: error instanceof Error ? error : String(error),
            });
          })
          .finally(() => {
            this.retryingJobIds.delete(job.jobId);
          });
      }
    } catch (error) {
      this.logger.error("source-archive-recovery scan failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
