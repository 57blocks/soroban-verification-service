import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { createS3Client, deleteObject } from "@scvs/aws";
import { DetachedWork, ScvsLogger, ScvsMetrics, startInterval } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class JobRetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("job-retention");
  private readonly metrics = new ScvsMetrics("job-retention", { logger: this.logger });
  private readonly detached = new DetachedWork(this.logger);

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "job-retention",
      this.configService.get("jobRetentionSweepIntervalMs", { infer: true }),
      () => this.sweep(),
      this.detached,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  async sweep(now = Date.now()): Promise<number> {
    try {
      const retentionMs = this.configService.get("jobRetentionMs", { infer: true });
      const candidates = await this.jobs.listPrunableJobs({
        before: new Date(now - retentionMs),
        limit: this.configService.get("jobRetentionBatchSize", { infer: true }),
      });
      this.metrics.gauge("retention_backlog", candidates.length);
      if (candidates.length === 0) return 0;

      // Delete the log object before the row: build_log_object_key is the only pointer to it.
      const deletable: string[] = [];
      for (const candidate of candidates) {
        if (await this.removeBuildLog(candidate.jobId, candidate.buildLogObjectKey)) {
          deletable.push(candidate.jobId);
        }
      }

      const pruned = await this.jobs.pruneJobs(deletable);
      if (pruned > 0) this.logger.log("pruned unpublished job records", { pruned, retention_ms: retentionMs });
      return pruned;
    } catch (error) {
      this.logger.error("job retention sweep failed", {
        error: error instanceof Error ? error : String(error),
      });
      return 0;
    }
  }

  private async removeBuildLog(jobId: string, objectKey?: string): Promise<boolean> {
    if (!objectKey) return true;
    const staging = this.configService.get("stagingStorage", { infer: true });
    try {
      await deleteObject(createS3Client({ region: staging.region }), staging.bucket, objectKey);
      return true;
    } catch (error) {
      this.logger.error("job retention: build log delete failed, job row kept", {
        job_id: jobId,
        object_key: objectKey,
        error: error instanceof Error ? error : String(error),
      });
      return false;
    }
  }
}
