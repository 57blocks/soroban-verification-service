import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { ScvsLogger, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import { PublishService } from "../publish/publish.service.js";
import { StartupRecoveryService } from "./startup-recovery.service.js";
import type { AppConfigService } from "../../config/configuration.js";

/** Enough ids to act on; a backlog-sized array in one log record helps nobody. */
const LOGGED_ID_LIMIT = 20;

/** How long a job may sit in `publishing` before its worker is presumed dead. */
const PUBLISH_STALE_MS = Number(process.env.SCVS_PUBLISH_STALE_MS || 600_000);

@Injectable()
export class PublishRecoveryScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("publish-recovery");

  constructor(
    @Inject(StartupRecoveryService) private readonly startupRecovery: StartupRecoveryService,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(PublishService) private readonly publish: PublishService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "publish-recovery",
      this.configService.get("publishRecoveryIntervalMs", { infer: true }),
      () => this.recoverStuckPublishes(),
    );
    void this.recoverStuckPublishes();
  }

  async recoverStuckPublishes(): Promise<void> {
    try {
      const maxAttempts = this.configService.get("maxPublishAttempts", { infer: true });

      // `publishing` is the one non-terminal state outside the dispatch poll loop, so it is the one a crashed
      // worker can strand.
      const released = await this.jobs.releaseStalePublishing(new Date(Date.now() - PUBLISH_STALE_MS));
      if (released.length > 0) {
        this.logger.warn("released jobs left mid-publication by a stopped worker", {
          count: released.length,
          stale_minutes: Math.round(PUBLISH_STALE_MS / 60_000),
          job_ids: released.slice(0, LOGGED_ID_LIMIT),
        });
      }

      const pending = await this.jobs.listJobsByStatus(["publish_pending"]);
      for (const job of pending) {
        // Releasing says "the worker holding this has gone quiet for `PUBLISH_STALE_MS`"; it does not say the
        // worker is *gone*.
        if (released.includes(job.jobId)) continue;
        if (!job.result) continue; // nothing to publish; a verdict write that did not land
        // Bounded, so a permanently misconfigured publisher stops being retried every minute for the life of
        // the process.
        if (job.publishAttempts >= maxAttempts) continue;
        // No in-process `Set` guarding this loop any more: `publishJobResult` claims `publish_pending ->
        // publishing` itself, so two replicas scanning in the same second produce exactly one publish.
        void this.publish.publishJobResult(job.jobId).catch((error) => {
          this.logger.error("recovery failed to publish job", {
            job_id: job.jobId,
            error: error instanceof Error ? error : String(error),
          });
        });
      }
    } catch (error) {
      this.logger.error("publish-recovery scan failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
