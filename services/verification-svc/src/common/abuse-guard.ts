import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ScvsLogger } from "@scvs/core";
import { AbuseControlRepository } from "@scvs/db";
import type { Request } from "express";
import type { AppConfigService } from "../config/configuration.js";

const DEFAULT_ABUSE_WINDOW_MS = 60_000;
export const DEFAULT_ABUSE_MAX_PER_WINDOW = 6;

/** HMAC of `req.ip` under the deployment secret; the window is in the input so windows cannot be linked. */
export function fingerprintRequest(req: Request, windowStart: Date, key: string): string {
  const identity = req.ip || req.socket.remoteAddress || "unknown";
  return createHmac("sha256", key).update(`${identity}|${windowStart.toISOString()}`).digest("hex");
}

function currentWindowStart(windowMs: number, now = Date.now()): Date {
  return new Date(Math.floor(now / windowMs) * windowMs);
}

/** Unwindowed so it stays stable while a stream is open; null, not a shared bucket, when no address is known. */
export function fingerprintIp(req: Request, key: string): string | null {
  const identity = req.ip || req.socket.remoteAddress;
  if (!identity) return null;
  return createHmac("sha256", key).update(identity).digest("hex");
}

export const DEFAULT_FAILOPEN_THRESHOLD = 10;

export type AbuseCheckResult =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited" | "fail_closed" };

const RATE_LIMITED_ERROR = {
  error: "rate_limited",
  message: "Too many requests, please try again later.",
} as const;

const FAIL_CLOSED_ERROR = {
  error: "abuse_check_unavailable",
  message:
    "The abuse-check database is currently unreachable, so this route cannot verify your request budget " +
    "and is refusing new requests rather than admitting them unchecked. Retry shortly.",
} as const;

export function abuseCheckError(
  result: Extract<AbuseCheckResult, { allowed: false }>,
): { statusCode: 429 | 503; detail: typeof RATE_LIMITED_ERROR | typeof FAIL_CLOSED_ERROR } {
  return result.reason === "fail_closed"
    ? { statusCode: 503, detail: FAIL_CLOSED_ERROR }
    : { statusCode: 429, detail: RATE_LIMITED_ERROR };
}

@Injectable()
export class AbuseGuardService {
  private consecutiveFailOpens = 0;

  constructor(
    @Inject(AbuseControlRepository)
    private readonly abuseControl: AbuseControlRepository,
    @Inject(ConfigService)
    private readonly configService: AppConfigService
  ) {}

  async checkAbuse(
    req: Request,
    route: string,
    maxPerWindow: number = DEFAULT_ABUSE_MAX_PER_WINDOW,
    windowMs: number = DEFAULT_ABUSE_WINDOW_MS,
    now: number = Date.now()
  ): Promise<{ allowed: boolean }> {
    const windowStart = currentWindowStart(windowMs, now);
    const fingerprint = fingerprintRequest(
      req,
      windowStart,
      this.configService.get("abuseFingerprintKey", { infer: true })
    );
    const count = await this.abuseControl.incrementAbuseCounter(fingerprint, route, windowStart);
    return { allowed: count <= maxPerWindow };
  }

  async checkAbuseFailOpen(
    req: Request,
    route: string,
    maxPerWindow: number,
    windowMs: number,
    logger: ScvsLogger,
    failOpenThreshold: number = DEFAULT_FAILOPEN_THRESHOLD,
  ): Promise<AbuseCheckResult> {
    try {
      const { allowed } = await this.checkAbuse(req, route, maxPerWindow, windowMs);
      this.consecutiveFailOpens = 0;
      return allowed ? { allowed: true } : { allowed: false, reason: "rate_limited" };
    } catch (error) {
      this.consecutiveFailOpens++;
      if (this.consecutiveFailOpens > failOpenThreshold) {
        logger.error("DB-backed abuse check failed, failing CLOSED", {
          consecutive_failures: this.consecutiveFailOpens,
          fail_open_threshold: failOpenThreshold,
          error: error instanceof Error ? error : String(error),
        });
        return { allowed: false, reason: "fail_closed" };
      }
      logger.error("DB-backed abuse check failed, failing open", {
        error: error instanceof Error ? error : String(error),
      });
      return { allowed: true };
    }
  }
}
