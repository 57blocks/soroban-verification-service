import { Controller, Get, Inject, Res } from "@nestjs/common";
import { DrainState, readiness, type ReadinessReport } from "@scvs/core";
import { DbHealthService } from "@scvs/db";
import type { Response } from "express";
import { WorkerTickState } from "../../common/worker-tick.module.js";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(DrainState) private readonly drain: DrainState,
    @Inject(DbHealthService) private readonly dbHealth: DbHealthService,
    @Inject(WorkerTickState) private readonly worker: WorkerTickState,
  ) {}

  /** The container HEALTHCHECK asserts this exact body. */
  @Get()
  getHealth(): { status: string } {
    return { status: "ok" };
  }

  @Get("live")
  getLive(): { status: "alive" } {
    return { status: "alive" };
  }

  @Get("ready")
  async getReady(@Res({ passthrough: true }) response: Response): Promise<
    ReadinessReport & {
      worker?: { queue_depth: number; jobs_in_flight: number; last_tick_at: string };
    }
  > {
    const report = readiness(this.drain, { database: await this.dbHealth.ping() });
    if (!report.ready) response.status(503);

    const tick = this.worker.tick;
    return {
      ...report,
      ...(tick
        ? {
            worker: {
              queue_depth: tick.queueDepth,
              jobs_in_flight: tick.inFlight,
              last_tick_at: tick.at,
            },
          }
        : {}),
    };
  }
}
