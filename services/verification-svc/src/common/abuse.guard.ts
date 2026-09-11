import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ScvsLogger } from "@scvs/core";
import type { Request } from "express";
import { AbuseGuardService } from "./abuse-guard.js";
import { ApiError } from "./api-error.exception.js";
import type { AppConfigService } from "../config/configuration.js";

/**
 * Routes on the stricter budget. Both are the same caller in the same flow — a client uploading source is one
 * about to submit — so they are one tier, not two.
 */
const SUBMISSION_ROUTES = new Set([
  "/api/verification/v1/verifications",
  "/api/verification/v1/uploads/source",
]);

/**
 * The Postgres-backed sliding-window guard, applied via `@UseGuards(AbuseGuard)` on
 * `/api/verification/v1/preflight`, `/api/verification/v1/verifications` and
 * `/api/verification/v1/uploads/source`.
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
    try {
      // An unmatched route resolves to the strictest tier rather than the loosest.
      const maxPerWindow =
        route === undefined || SUBMISSION_ROUTES.has(route)
          ? this.configService.get("submitAbuseMaxPerWindow", { infer: true })
          : this.configService.get("abuseMaxPerWindow", { infer: true });
      const windowMs = this.configService.get("abuseWindowMs", { infer: true });
      const { allowed } = await this.abuse.checkAbuse(req, route ?? "unmatched", maxPerWindow, windowMs);
      if (!allowed) {
        throw new ApiError(429, { error: "rate_limited", message: "Too many requests, please try again later." });
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Failing open is deliberate (the guard must not take the API down with the database), which is exactly
      // why it must be loud: this record is the only sign the quota is not being enforced.
      this.logger.error("DB-backed abuse check failed, failing open", {
        error: error instanceof Error ? error : String(error),
      });
      return true;
    }
  }
}
