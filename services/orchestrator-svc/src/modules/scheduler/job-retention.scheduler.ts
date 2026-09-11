import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { createS3Client, deleteObject } from "@scvs/aws";
import { ScvsLogger, ScvsMetrics } from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import type { AppConfigService } from "../../config/configuration.js";

// Reads `process.env` directly rather than through `ConfigService`: `@Interval(...)` is a decorator argument,
// evaluated at class-definition time (module load), before Nest's DI container exists.
const RETENTION_SWEEP_INTERVAL_MS = Number(process.env.SCVS_JOB_RETENTION_SWEEP_INTERVAL_MS || 60 * 60_000);

/**
 * Prunes job records that never reached publication (retention-and-pseudonymisation design.md RP-3). A job
 * whose `published_updated_at` is set is a published record and is never touched at any age — it is what a
 * consumer's incremental sync reads through `listPublished`.
 */
@Injectable()
export class JobRetentionScheduler {
  private readonly logger = new ScvsLogger("job-retention");
  private readonly metrics = new ScvsMetrics("job-retention", { logger: this.logger });

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ConfigService) private readonly configService: AppConfigService,
  ) {}

  @Interval(RETENTION_SWEEP_INTERVAL_MS)
  async sweep(now = Date.now()): Promise<number> {
    try {
      const retentionMs = this.configService.get("jobRetentionMs", { infer: true });
      const candidates = await this.jobs.listPrunableJobs({
        before: new Date(now - retentionMs),
        limit: this.configService.get("jobRetentionBatchSize", { infer: true }),
      });
      this.metrics.gauge("retention_backlog", candidates.length);
      if (candidates.length === 0) return 0;

      // A job whose log object could not be deleted keeps its row and is retried next tick: `build_log_object_key`
      // is the only pointer to that object, so the opposite ordering retains the log AND loses the way to reach it.
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
      // A silent failure here is a retention breach nothing else reports.
      this.logger.error("job retention sweep failed", {
        error: error instanceof Error ? error : String(error),
      });
      return 0;
    }
  }

  /** True when there is nothing left in the staging bucket for this job — including when there never was. */
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
