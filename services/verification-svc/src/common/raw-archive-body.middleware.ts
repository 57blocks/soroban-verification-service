import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DrainState, ScvsLogger } from "@scvs/core";
import type { NextFunction, Request, Response } from "express";
import { abuseCheckError, AbuseGuardService } from "./abuse-guard.js";
import { UPLOAD_SOURCE_ROUTE } from "./abuse.guard.js";

import type { AppConfigService } from "../config/configuration.js";
import { errorBody } from "@scvs/http";

/** Small because Content-Length is optional: preallocating the ceiling would cost a full-size buffer per connection. */
const UNSIZED_BODY_INITIAL_BYTES = 64 * 1024;

/** Runs the drain, then abuse checks itself: a guard would only run after the body is fully buffered. */
@Injectable()
export class RawArchiveBodyMiddleware implements NestMiddleware {
  private readonly logger = new ScvsLogger("raw-archive-body-middleware");

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
      this.discardAndClose(req, res);
      return;
    }

    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      res.status(413).json(
        errorBody(413, {
          error: "source_archive_too_large",
          message: `Source archive exceeds ${maxUploadBytes} bytes.`,
        }),
      );
      this.discardAndClose(req, res);
      return;
    }

    const result = await this.abuse.checkAbuseFailOpen(
      req,
      UPLOAD_SOURCE_ROUTE,
      this.configService.get("submitAbuseMaxPerWindow", { infer: true }),
      this.configService.get("abuseWindowMs", { infer: true }),
      this.logger,
      this.configService.get("abuseFailOpenThreshold", { infer: true }),
    );
    if (!result.allowed) {
      const { statusCode, detail } = abuseCheckError(result);
      res.status(statusCode).json(errorBody(statusCode, detail));
      this.discardAndClose(req, res);
      return;
    }

    let buffer = Buffer.allocUnsafe(
      Number.isFinite(declaredLength) ? declaredLength : Math.min(UNSIZED_BODY_INITIAL_BYTES, maxUploadBytes),
    );
    let size = 0;
    // Several "data" events can pass the ceiling before destroy() takes effect; this stops a second res.json().
    let rejected = false;

    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxUploadBytes) {
        rejected = true;
        res.status(413).json(
          errorBody(413, {
            error: "source_archive_too_large",
            message: `Source archive exceeds ${maxUploadBytes} bytes.`,
          }),
        );
        this.discardAndClose(req, res);
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
      if (rejected) return;
      (req as Request & { body: Buffer }).body = buffer.subarray(0, size);
      next();
    });

    req.on("error", next);
  }

  // `req` starts paused: resume() drains the unread body so backpressure cannot stall the response, and
  // destroy() waits for "finish" because destroying at once would race that write.
  private discardAndClose(req: Request, res: Response): void {
    req.resume();
    res.on("finish", () => req.destroy());
  }
}
