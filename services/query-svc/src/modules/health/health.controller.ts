import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { DrainState, readiness, type ReadinessReport } from "@scvs/core";
import { DbHealthService } from "@scvs/db-query";
import type { Response } from "express";
import { healthPayload } from "./health.util.js";
import type { AppConfigService } from "../../config/configuration.js";

// Never throttled: the container HEALTHCHECK and the ALB target group are the heaviest callers of these
// routes, and a probe refused with 429 is a probe that failed — the quota would take the task out of
// service for being healthy enough to be polled.
@SkipThrottle()
@Controller("health")
export class HealthController {
  // Explicit `@Inject()` — tsx/esbuild does not emit the decorator metadata Nest would otherwise infer
  // these parameter types from.
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(DrainState) private readonly drain: DrainState,
    @Inject(DbHealthService) private readonly dbHealth: DbHealthService,
  ) {}

  /** Unchanged: the container `HEALTHCHECK`, the ALB target group, and an existing spec read this. */
  @Get()
  getHealth(): { status: string; version: string } {
    return healthPayload("0.1.0");
  }

  /** Liveness: the process is up. Checks no dependencies — see verification-svc's controller for why. */
  @Get("live")
  @ApiOperation({ summary: "Liveness — the process is up. Checks no dependencies, by design." })
  @ApiOkResponse({ description: "alive" })
  getLive(): { status: "alive" } {
    return { status: "alive" };
  }

  /**
   * Readiness: should the balancer still send this task reads?
   *
   * Every route but this tree reads Postgres, so a task that cannot reach it can serve nothing — answering 200
   * here while the database is gone keeps a useless instance in the target group. The probe is bounded (see
   * `DbHealthService.ping`), and the bound must stay below the balancer's own health-check timeout, or the
   * balancer gives up before this route answers and the report is never read.
   */
  @Get("ready")
  @ApiOperation({ summary: "Readiness — false while draining, or while Postgres is unreachable." })
  @ApiOkResponse({ description: "ready to serve reads" })
  @ApiServiceUnavailableResponse({ description: "draining, or a dependency is unavailable" })
  async getReady(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const database = await this.dbHealth.ping(
      this.configService.get("readinessDbTimeoutMs", { infer: true }),
    );
    const report = readiness(this.drain, { database });
    if (!report.ready) response.status(503);
    return report;
  }
}
