import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse } from "@nestjs/swagger";
import { DrainState, readiness, type ReadinessReport } from "@scvs/core";
import type { Response } from "express";
import { healthPayload } from "./health.util.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(DrainState) private readonly drain: DrainState) {}

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

  /** Readiness for the read layer, and **it probes no dependency**. */
  @Get("ready")
  @ApiOperation({
    summary: "Readiness — false only while draining. Probes no dependency; the source says why.",
  })
  @ApiOkResponse({ description: "ready to serve reads" })
  @ApiServiceUnavailableResponse({ description: "draining" })
  getReady(@Res({ passthrough: true }) response: Response): ReadinessReport {
    const report = readiness(this.drain, {});
    if (!report.ready) response.status(503);
    return report;
  }
}
