import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DrainState, ScvsLogger } from "@scvs/core";
import type { NextFunction, Request, Response } from "express";
import { AbuseGuardService } from "./abuse-guard.js";
import { errorBody } from "./api-error.exception.js";
import type { AppConfigService } from "../config/configuration.js";

/** Must match `abuse.guard.ts`'s `SUBMISSION_ROUTES` key for this same path. */
const ROUTE = "api/verification/v1/uploads/source";

/**
 * Accumulates the raw request body as a Buffer instead of parsing it as JSON — uploads are binary tarballs.
 *
 * Also carries this route's drain and abuse checks, run here rather than through `@UseGuards(DrainGuard,
 * AbuseGuard)` on the controller: a guard only runs once the body has already been fully buffered, which
 * defeats the point of metering an upload before memory is spent on it. Drain runs first, matching the
 * ordering `submit` uses on the controller — refusing a submission the instance is about to stop serving
 * should not consume the submitter's abuse-check quota.
 */
@Injectable()
export class RawArchiveBodyMiddleware implements NestMiddleware {
  private readonly logger = new ScvsLogger("raw-archive-body-middleware");

  // Explicit `@Inject()` — see preflight.controller.ts's comment (tsx/esbuild doesn't emit the decorator
  // metadata Nest's DI would otherwise infer this parameter's type from).
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(AbuseGuardService) private readonly abuse: AbuseGuardService,
    @Inject(DrainState) private readonly drain: DrainState,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const maxUploadBytes = this.configService.get("maxSourceArchiveBytes", { infer: true });

    if (this.drain.isDraining) {
      res.status(503).json(
        errorBody(503, {
          error: "draining",
          message:
            "This instance is shutting down and is not accepting new submissions. Retry — the load " +
            "balancer will route you to another instance. Jobs already accepted are unaffected and their " +
            "status remains readable.",
        }),
      );
      req.destroy();
      return;
    }

    if (!(await this.isWithinAbuseBudget(req))) {
      res.status(429).json(errorBody(429, { error: "rate_limited", message: "Too many requests, please try again later." }));
      req.destroy();
      return;
    }

    // Reject before a single byte is buffered when the client already declares an oversized body — the
    // per-chunk check below still catches a missing or understated Content-Length.
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      res.status(413).json(
        errorBody(413, {
          error: "source_archive_too_large",
          message: `Source archive exceeds ${maxUploadBytes} bytes.`,
        }),
      );
      req.destroy();
      return;
    }

    // Not a chunk array concatenated at the end: that briefly holds both the parts and the whole at once.
    let buffer = Buffer.allocUnsafe(Number.isFinite(declaredLength) ? declaredLength : maxUploadBytes);
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxUploadBytes) {
        res.status(413).json(
          errorBody(413, {
            error: "source_archive_too_large",
            message: `Source archive exceeds ${maxUploadBytes} bytes.`,
          }),
        );
        req.destroy();
        return;
      }
      const offset = size - chunk.length;
      // max(size, ...): doubling alone can still undershoot a single large chunk.
      if (size > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(Math.max(buffer.length * 2, size), maxUploadBytes));
        buffer.copy(grown, 0, 0, offset);
        buffer = grown;
      }
      chunk.copy(buffer, offset);
    });

    req.on("end", () => {
      (req as Request & { body: Buffer }).body = buffer.subarray(0, size);
      next();
    });

    req.on("error", next);
  }

  /** Mirrors `AbuseGuard.canActivate`'s fail-open behavior: a DB-backed check must not take the API down. */
  private async isWithinAbuseBudget(req: Request): Promise<boolean> {
    try {
      const { allowed } = await this.abuse.checkAbuse(
        req,
        ROUTE,
        this.configService.get("submitAbuseMaxPerWindow", { infer: true }),
        this.configService.get("abuseWindowMs", { infer: true }),
      );
      return allowed;
    } catch (error) {
      this.logger.error("DB-backed abuse check failed, failing open", {
        error: error instanceof Error ? error : String(error),
      });
      return true;
    }
  }
}
