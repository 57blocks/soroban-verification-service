import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { createS3Client, deleteObject } from "@scvs/aws";
import { DetachedWork, ScvsLogger, ScvsMetrics, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class BuildLogExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("build-log-expiry");
  private readonly metrics = new ScvsMetrics("build-log-expiry", { logger: this.logger });
  private readonly detached = new DetachedWork(this.logger);

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "build-log-expiry",
      this.configService.get("buildLogSweepIntervalMs", { infer: true }),
      () => this.sweep(),
      this.detached,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  async sweep(now = Date.now()): Promise<number> {
    try {
      const keys = await this.jobs.listExpiredBuildLogs(
        new Date(now),
        this.configService.get("buildLogSweepBatchSize", { infer: true }),
      );
      this.metrics.gauge("build_log_expiry_backlog", keys.length);
      if (keys.length === 0) return 0;

      const staging = this.configService.get("stagingStorage", { infer: true });
      const s3 = createS3Client({ region: staging.region });
      let deleted = 0;
      for (const objectKey of keys) {
        try {
          await deleteObject(s3, staging.bucket, objectKey);
          // Only after the delete: clearing the key first would leave an object nothing points at.
          await this.jobs.clearBuildLogKey(objectKey);
          deleted += 1;
        } catch (error) {
          this.logger.error("build log delete failed; the key is kept and retried next tick", {
            object_key: objectKey,
            error: error instanceof Error ? error : String(error),
          });
        }
      }
      if (deleted > 0) this.logger.log("expired build logs deleted", { deleted });
      return deleted;
    } catch (error) {
      this.logger.error("build log expiry sweep failed", {
        error: error instanceof Error ? error : String(error),
      });
      return 0;
    }
  }
}
