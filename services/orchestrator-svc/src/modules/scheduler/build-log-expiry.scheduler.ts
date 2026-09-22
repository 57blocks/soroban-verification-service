import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { createS3Client, deleteObject } from "@scvs/aws";
import { ScvsLogger, ScvsMetrics, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import type { AppConfigService } from "../../config/configuration.js";

/**
 * Removes raw build logs past their retention period (build-log-access design.md BL-2).
 *
 * It is not what makes an expired log unreadable — `JobsService.getBuildLog` already answers `410` from the
 * row, so a sweep that is late or wedged cannot extend the promise. This is what removes the bytes.
 */
@Injectable()
export class BuildLogExpiryScheduler implements OnModuleInit {
  private readonly logger = new ScvsLogger("build-log-expiry");
  private readonly metrics = new ScvsMetrics("build-log-expiry", { logger: this.logger });

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
    );
  }

  async sweep(now = Date.now()): Promise<number> {
    try {
      // Object keys, not job ids: one rebuild's log serves every job attached to it, and `listExpiredBuildLogs`
      // returns a key only when the LAST of those jobs has expired and none is held (ADR-008).
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
          // Only after the bytes are gone: clearing first would leave an object nothing points at, which is
          // the state the job-retention sweep (retention-and-pseudonymisation RP-3) prevents for the
          // same reason.
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
      // A silent failure here is a retention breach nothing else reports.
      this.logger.error("build log expiry sweep failed", {
        error: error instanceof Error ? error : String(error),
      });
      return 0;
    }
  }
}
