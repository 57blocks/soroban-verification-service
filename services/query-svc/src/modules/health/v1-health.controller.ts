import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { healthPayload } from "./health.util.js";

@SkipThrottle()
@Controller()
export class V1HealthController {
  @Get("api/query/v1/health")
  @ApiOperation({ operationId: "getHealth", summary: "Liveness and version." })
  @ApiOkResponse({ description: "ok" })
  getHealth(): { status: string; version: string } {
    return healthPayload("0.1.0");
  }
}
