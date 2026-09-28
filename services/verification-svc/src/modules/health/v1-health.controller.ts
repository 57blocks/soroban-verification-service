import { Controller, Get, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOkResponse, ApiOperation } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { healthPayload } from "./health.util.js";
import type { AppConfigService } from "../../config/configuration.js";

/** Not a `HealthController` method: its `health` prefix would resolve this to `/health/api/verification/v1/health`. */
@SkipThrottle()
@Controller()
export class V1HealthController {
  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  @Get("api/verification/v1/health")
  @ApiOperation({ operationId: "getHealth", summary: "Liveness and version." })
  @ApiOkResponse({ description: "ok" })
  getHealth(): { status: string; version: string } {
    return healthPayload(this.configService.get("serviceVersion", { infer: true }));
  }
}
