import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ScvsLogger } from "@scvs/core";
import type { Request } from "express";
import { abuseCheckError, AbuseGuardService } from "./abuse-guard.js";

import type { AppConfigService } from "../config/configuration.js";
import { ApiError } from "@scvs/http";

/** Middleware runs before Nest resolves `req.route.path`, so the upload middleware keys its check on this. */
export const UPLOAD_SOURCE_ROUTE = "/api/verification/v1/uploads/source";

const SUBMISSION_ROUTES = new Set(["/api/verification/v1/verifications", UPLOAD_SOURCE_ROUTE]);

const STREAM_ROUTES = new Set(["/api/verification/v1/verifications/:job_id/events"]);

@Injectable()
export class AbuseGuard implements CanActivate {
  private readonly logger = new ScvsLogger("abuse-guard");

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(AbuseGuardService) private readonly abuse: AbuseGuardService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    // The route pattern, not the URL: a path parameter in the key would give every id its own budget.
    const route = req.route?.path;
    const maxPerWindow =
      route === undefined || SUBMISSION_ROUTES.has(route)
        ? this.configService.get("submitAbuseMaxPerWindow", { infer: true })
        : STREAM_ROUTES.has(route)
          ? this.configService.get("streamAbuseMaxPerWindow", { infer: true })
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
