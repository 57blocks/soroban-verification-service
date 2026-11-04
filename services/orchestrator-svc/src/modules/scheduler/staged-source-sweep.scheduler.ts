import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { DetachedWork, RETRY_ELIGIBILITY_WINDOW_MS, ScvsLogger, ScvsMetrics, startInterval } from "@scvs/core";
import { RebuildsRepository } from "@scvs/db";
import { StagedSourceReleaseService } from "../source-resolution/index.js";
import type { AppConfigService } from "../../config/configuration.js";

@Injectable()
export class StagedSourceSweepScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new ScvsLogger("staged-source-sweep");
  private readonly metrics = new ScvsMetrics("staged-source-sweep", { logger: this.logger });
  private readonly detached = new DetachedWork(this.logger);

  constructor(
    @Inject(RebuildsRepository) private readonly rebuilds: RebuildsRepository,
    @Inject(StagedSourceReleaseService) private readonly release: StagedSourceReleaseService,
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(SchedulerRegistry) private readonly schedule: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    startInterval(
      this.schedule,
      "staged-source-sweep",
      this.configService.get("stagedSourceSweepIntervalMs", { infer: true }),
      () => this.sweep(),
      this.detached,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.detached.drain();
  }

  /** Finished rebuilds whose staging copies the terminal path did not release; oldest first, one bounded batch. */
  async sweep(now = Date.now()): Promise<number> {
    try {
      const candidates = await this.rebuilds.listStagedSourceReleaseCandidates({
        doneBefore: new Date(now - RETRY_ELIGIBILITY_WINDOW_MS),
        limit: this.configService.get("stagedSourceSweepBatchSize", { infer: true }),
      });
      this.metrics.gauge("staged_source_release_backlog", candidates.length);
      let released = 0;
      for (const rebuild of candidates) {
        try {
          if ((await this.release.releaseRebuildSources(rebuild.rebuildId, "sweep")) === "released") released += 1;
        } catch (error) {
          this.logger.error("staged source sweep: release failed, rebuild left for the next tick", {
            rebuild_id: rebuild.rebuildId,
            error: error instanceof Error ? error : String(error),
          });
        }
      }
      if (released > 0) this.logger.log("staged source sweep released rebuilds", { released });
      return released;
    } catch (error) {
      this.logger.error("staged source sweep failed", {
        error: error instanceof Error ? error : String(error),
      });
      return 0;
    }
  }
}
