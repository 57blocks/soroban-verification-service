import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ScvsLogger } from "@scvs/core";
import type { Request } from "express";
import { abuseCheckError, AbuseGuardService } from "./abuse-guard.js";
import { ApiError } from "./api-error.exception.js";
import type { AppConfigService } from "../config/configuration.js";

/**
 * Exported so `raw-archive-body.middleware.ts` can key its own abuse check on the exact same string this
 * guard would have used, had it still applied to that route — middleware runs before Nest resolves
 * `req.route.path`, so it cannot read the pattern back the way this guard does.
 */
export const UPLOAD_SOURCE_ROUTE = "/api/verification/v1/uploads/source";

/**
 * Routes on the stricter budget. Both are the same caller in the same flow — a client uploading source is one
 * about to submit — so they are one tier, not two.
 */
const SUBMISSION_ROUTES = new Set(["/api/verification/v1/verifications", UPLOAD_SOURCE_ROUTE]);

/**
 * The Postgres-backed sliding-window guard, applied via `@UseGuards(AbuseGuard)` on
 * `/api/verification/v1/preflight`, `/api/verification/v1/verifications`, and the build-log routes.
 */
@Injectable()
export class AbuseGuard implements CanActivate {
  private readonly logger = new ScvsLogger("abuse-guard");

  // Explicit `@Inject()` — see preflight.controller.ts's comment (tsx/esbuild doesn't emit the decorator
  // metadata Nest's DI would otherwise infer this parameter's type from).
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(AbuseGuardService) private readonly abuse: AbuseGuardService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    // The matched route pattern, not the URL: a path parameter in the key would give every distinct id its own
    // budget, which is no budget at all.
    const route = req.route?.path;
    // An unmatched route resolves to the strictest tier rather than the loosest.
    const maxPerWindow =
      route === undefined || SUBMISSION_ROUTES.has(route)
        ? this.configService.get("submitAbuseMaxPerWindow", { infer: true })
        : this.configService.get("abuseMaxPerWindow", { infer: true });
    const windowMs = this.configService.get("abuseWindowMs", { infer: true });
    const result = await this.abuse.checkAbuseFailOpen(
      req,
      route ?? "unmatched",
      maxPerWindow,
      windowMs,
      this.logger,
      this.configService.get("abuseFailOpenThreshold", { infer: true }),
    );
    if (!result.allowed) {
      const { statusCode, detail } = abuseCheckError(result);
      throw new ApiError(statusCode, detail);
    }
    return true;
  }
}
