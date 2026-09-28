import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { DrainState, readiness, type ReadinessReport } from "@scvs/core";
import { DbHealthService } from "@scvs/db-query";
import type { Response } from "express";
import { healthPayload } from "./health.util.js";
import type { AppConfigService } from "../../config/configuration.js";

@SkipThrottle()
@Controller("health")
export class HealthController {
  // Explicit `@Inject()`: tsx/esbuild emits no decorator metadata.
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(DrainState) private readonly drain: DrainState,
    @Inject(DbHealthService) private readonly dbHealth: DbHealthService,
  ) {}

  @Get()
  getHealth(): { status: string; version: string } {
    return healthPayload("0.1.0");
  }

  @Get("live")
  @ApiOperation({ summary: "Liveness — the process is up. Checks no dependencies, by design." })
  @ApiOkResponse({ description: "alive" })
  getLive(): { status: "alive" } {
    return { status: "alive" };
  }

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
