import { Controller, Get, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOkResponse, ApiOperation } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { healthPayload } from "./health.util.js";
import type { AppConfigService } from "../../config/configuration.js";

/**
 * Its own controller rather than a method on `HealthController`: that class's `@Controller("health")` prefix
 * would resolve `@Get("api/verification/v1/health")` to `/health/api/verification/v1/health`.
 */
@SkipThrottle()
@Controller()
export class V1HealthController {
  // Explicit `@Inject()` — see preflight.controller.ts's comment (tsx/esbuild doesn't emit the decorator
  // metadata Nest's DI would otherwise infer this parameter's type from).
  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  @Get("api/verification/v1/health")
  @ApiOperation({ operationId: "getHealth", summary: "Liveness and version." })
  @ApiOkResponse({ description: "ok" })
  getHealth(): { status: string; version: string } {
    return healthPayload(this.configService.get("serviceVersion", { infer: true }));
  }
}
