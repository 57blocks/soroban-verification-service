import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { healthPayload } from "./health.util.js";

@SkipThrottle()
@ApiTags("Health")
@Controller()
export class V1HealthController {
  @Get("api/query/v1/health")
  @ApiOperation({
    operationId: "getHealth",
    summary: "Check that the service is up",
    description: "Answers `status: \"ok\"` and a `version` string while the process is up. It checks no dependency.",
  })
  @ApiOkResponse({ description: "ok" })
  getHealth(): { status: string; version: string } {
    return healthPayload("0.1.0");
  }
}
