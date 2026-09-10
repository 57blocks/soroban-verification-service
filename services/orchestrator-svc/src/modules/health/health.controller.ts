import { Controller, Get, Inject, Res } from "@nestjs/common";
import { DrainState, readiness, type ReadinessReport } from "@scvs/core";
import { DbHealthService } from "@scvs/db";
import type { Response } from "express";
import { WorkerTickState } from "../../common/worker-tick.module.js";

/** orchestrator-svc has no public-facing surface (no ALB — see infra/cdk/lib/services-stack.ts's comment). */
@Controller("health")
export class HealthController {
  // Explicit `@Inject()` — see build-dispatch.scheduler.ts's comment.
  constructor(
    @Inject(DrainState) private readonly drain: DrainState,
    @Inject(DbHealthService) private readonly dbHealth: DbHealthService,
    @Inject(WorkerTickState) private readonly worker: WorkerTickState,
  ) {}

  /** Unchanged: the container `HEALTHCHECK` and an existing spec assert this exact body. */
  @Get()
  getHealth(): { status: string } {
    return { status: "ok" };
  }

  /** Liveness: the process is up. Checks no dependencies — see verification-svc's controller for why. */
  @Get("live")
  getLive(): { status: "alive" } {
    return { status: "alive" };
  }

  /**
   * Readiness, and for this service it is what a **drain** gets confirmed with rather than what a balancer
   * reads: `queue_depth` and `jobs_in_flight` are what the drain runbook watches reach zero before letting the
   * replacement start.
   */
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
