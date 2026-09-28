import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { DrainState, readiness, type ReadinessReport } from "@scvs/core";
import { DbHealthService } from "@scvs/db";
import type { Response } from "express";
import { healthPayload } from "./health.util.js";
import type { AppConfigService } from "../../config/configuration.js";

@SkipThrottle()
@Controller("health")
export class HealthController {
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(DrainState) private readonly drain: DrainState,
    @Inject(DbHealthService) private readonly dbHealth: DbHealthService,
  ) {}

  /** The Dockerfile HEALTHCHECK and the ALB target group depend on this route and body. */
  @Get()
  getHealth(): { status: string; version: string } {
    return healthPayload(this.configService.get("serviceVersion", { infer: true }));
  }

  /** Checks nothing else: a liveness probe that fails on a dependency turns a database blip into a restart loop. */
  @Get("live")
  @ApiOperation({ summary: "Liveness — the process is up. Checks no dependencies, by design." })
  @ApiOkResponse({ description: "alive" })
  getLive(): { status: "alive" } {
    return { status: "alive" };
  }

  @Get("ready")
  @ApiOperation({ summary: "Readiness — false while draining, or while Postgres is unreachable." })
  @ApiOkResponse({ description: "ready for new work" })
  @ApiServiceUnavailableResponse({ description: "draining, or a dependency is unavailable" })
  async getReady(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const report = readiness(this.drain, { database: await this.dbHealth.ping() });
    if (!report.ready) response.status(503);
    return report;
  }
}
