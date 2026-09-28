import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DetachedWork, ScvsLogger, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import { PublishService } from "../publish/index.js";
import { StartupRecoveryService } from "./startup-recovery.service.js";
import type { AppConfigService } from "../../config/configuration.js";

const LOGGED_ID_LIMIT = 20;

const PUBLISH_STALE_MS = Number(process.env.SCVS_PUBLISH_STALE_MS || 600_000);

@Injectable()
export class PublishRecoveryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("publish-recovery");
  private readonly detached = new DetachedWork(this.logger);

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
      this.detached,
    );
    this.detached.start(() => this.recoverStuckPublishes());
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  async recoverStuckPublishes(): Promise<void> {
    try {
      const maxAttempts = this.configService.get("maxPublishAttempts", { infer: true });

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
        // Released does not mean the worker is gone; skip jobs this tick just released.
        if (released.includes(job.jobId)) continue;
        if (!job.result) continue;
        if (job.publishAttempts >= maxAttempts) continue;
        this.detached.start(() =>
          this.publish.publishJobResult(job.jobId).catch((error) => {
            this.logger.error("recovery failed to publish job", {
              job_id: job.jobId,
              error: error instanceof Error ? error : String(error),
            });
          }),
        );
      }
    } catch (error) {
      this.logger.error("publish-recovery scan failed", {
        error: error instanceof Error ? error : String(error),
      });
    }
  }
}
