import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation } from "@nestjs/swagger";
import { healthPayload } from "./health.util.js";

/** Its own controller rather than a method on `HealthController` for the same reason as verification-svc's. */
@Controller()
export class V1HealthController {
  @Get("api/query/v1/health")
  @ApiOperation({ operationId: "getHealth", summary: "Liveness and version." })
  @ApiOkResponse({ description: "ok" })
  getHealth(): { status: string; version: string } {
    // Same literal the bare `/health` route reports — see health.util.ts.
    return healthPayload("0.1.0");
  }
}
