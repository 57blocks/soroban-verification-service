import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ScvsLogger, ScvsMetrics } from "@scvs/core";
import { JobsRepository, RebuildsRepository, type JobRecord } from "@scvs/db";
import { stagedSourceKeys } from "../../common/staging-keys.util.js";
import type { AppConfigService } from "../../config/configuration.js";
import { SourceResolutionService } from "./source-resolution.service.js";

export type StagedSourceReleaseOutcome = "released" | "kept" | "not_done" | "already_released";

@Injectable()
export class StagedSourceReleaseService {
  private readonly logger = new ScvsLogger("staged-source-release");
  private readonly metrics = new ScvsMetrics("staged-source-release", { logger: this.logger });

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(RebuildsRepository) private readonly rebuilds: RebuildsRepository,
    @Inject(SourceResolutionService) private readonly sourceResolution: SourceResolutionService,
  ) {}

  /** Every terminal path ends here. A delete that fails is only logged: the sweep retries it. */
  async releaseForTerminalJob(job: Pick<JobRecord, "jobId" | "sourceRef" | "rebuildId">): Promise<void> {
    await this.sourceResolution.deleteStagedUpload(job.sourceRef);
    if (!job.rebuildId) return;
    try {
      await this.releaseRebuildSources(job.rebuildId, "job_terminal");
    } catch (error) {
      this.logger.warn("failed to release a rebuild's staged source copies at job termination", {
        job_id: job.jobId,
        rebuild_id: job.rebuildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Deletes a finished rebuild's staging copies once no attached job can still read them. */
  async releaseRebuildSources(rebuildId: string, trigger: "job_terminal" | "sweep"): Promise<StagedSourceReleaseOutcome> {
    const rebuild = await this.rebuilds.getById(rebuildId);
    if (!rebuild || rebuild.status !== "done") return "not_done";
    if (rebuild.stagedSourceReleasedAt) return "already_released";

    const owed = await this.jobs.hasOutstandingStagedSourceNeed(
      rebuildId,
      this.configService.get("stagingSweepJobAgeCeilingMs", { infer: true }),
      new Date(),
      this.configService.get("maxJobRetryAttempts", { infer: true }),
    );
    if (owed) {
      this.logger.log("keeping a rebuild's staged source copies: an attached job still needs them", {
        rebuild_id: rebuildId,
        trigger,
      });
      return "kept";
    }

    for (const key of stagedSourceKeys(rebuildId)) {
      await this.sourceResolution.deleteStagingObject(key);
    }
    await this.rebuilds.markStagedSourceReleased(rebuildId);
    this.metrics.counter("staged_source_released_total", 1, { trigger });
    this.logger.log("released a rebuild's staged source copies", { rebuild_id: rebuildId, trigger });
    return "released";
  }
}
