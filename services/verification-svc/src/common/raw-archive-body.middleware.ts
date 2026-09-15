import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DrainState, ScvsLogger } from "@scvs/core";
import type { NextFunction, Request, Response } from "express";
import { AbuseGuardService, FAIL_CLOSED_ERROR } from "./abuse-guard.js";
import { UPLOAD_SOURCE_ROUTE } from "./abuse.guard.js";
import { errorBody } from "./api-error.exception.js";
import type { AppConfigService } from "../config/configuration.js";

/**
 * Starting allocation for a body with no Content-Length to size it by. Small on purpose: a client can omit
 * the header at will, and preallocating the ceiling itself would let that alone force a full-size allocation
 * per connection — the growth path below (same one an understated Content-Length uses) picks up from here.
 */
const UNSIZED_BODY_INITIAL_BYTES = 64 * 1024;

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
      this.discardAndClose(req, res);
      return;
    }

    // Free and synchronous, so it runs before the DB-backed abuse check below: a flood of requests that only
    // ever declare an oversized body should not each cost a Postgres round-trip to reject.
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
      if (result.reason === "fail_closed") {
        res.status(503).json(errorBody(503, FAIL_CLOSED_ERROR));
      } else {
        res
          .status(429)
          .json(errorBody(429, { error: "rate_limited", message: "Too many requests, please try again later." }));
      }
      this.discardAndClose(req, res);
      return;
    }

    // Not a chunk array concatenated at the end: that briefly holds both the parts and the whole at once.
    let buffer = Buffer.allocUnsafe(
      Number.isFinite(declaredLength) ? declaredLength : Math.min(UNSIZED_BODY_INITIAL_BYTES, maxUploadBytes),
    );
    let size = 0;
    // Multiple "data" events can each push size past the ceiling before req.destroy() takes effect — without
    // this, a second rejection would call res.json() on an already-sent response and throw unhandled.
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

  /**
   * After sending a rejection, the client may still be mid-write on a body we're never going to read. `req`
   * defaults to paused, so an unconsumed stream fills the socket's receive buffer, applies TCP backpressure,
   * and can stall the very response we just sent. `resume()` drains the rest of the body instead; `destroy()`
   * waits for the response to actually finish sending, since an immediate destroy would race that write.
   */
  private discardAndClose(req: Request, res: Response): void {
    req.resume();
    res.on("finish", () => req.destroy());
  }
}
