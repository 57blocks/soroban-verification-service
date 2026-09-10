import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AbuseControlRepository } from "@scvs/db";
import type { Request } from "express";
import type { AppConfigService } from "../config/configuration.js";

/**
 * Sliding-window abuse control backed by Postgres (`abuse_control` table via `@scvs/db`'s
 * `AbuseControlRepository`).
 */
const DEFAULT_ABUSE_WINDOW_MS = 60_000;
/**
 * Only reached by a caller that omits the limit. The stricter of the two configured tiers, so an omission
 * cannot buy a wider budget than any real route has.
 */
export const DEFAULT_ABUSE_MAX_PER_WINDOW = 6;

/**
 * Identifies a submitter for ONE window without storing a reversible value: HMAC-SHA-256 of `req.ip` under a
 * deployment secret, with the window bound into the input. The secret defeats the dictionary attack an
 * unsalted hash over the IPv4 space permits; the window makes cross-window linking impossible rather than
 * merely prohibited, which is what "rotated at least daily" asks for and 1440x more often
 * (retention-and-pseudonymisation design.md RP-1).
 */
export function fingerprintRequest(req: Request, windowStart: Date, key: string): string {
  const identity = req.ip || req.socket.remoteAddress || "unknown";
  return createHmac("sha256", key).update(`${identity}|${windowStart.toISOString()}`).digest("hex");
}

function currentWindowStart(windowMs: number, now = Date.now()): Date {
  return new Date(Math.floor(now / windowMs) * windowMs);
}

@Injectable()
export class AbuseGuardService {
  // Explicit `@Inject()` — see preflight.controller.ts's comment (tsx/esbuild doesn't emit the decorator
  // metadata Nest's DI would otherwise infer this parameter's type from).
  constructor(
    @Inject(AbuseControlRepository)
    private readonly abuseControl: AbuseControlRepository,
    // Not `process.env` at module load, which is what the `@Interval`/`@Throttle` call sites here must do —
    // this is an ordinary injection, so it goes through ConfigService like every other setting.
    @Inject(ConfigService)
    private readonly configService: AppConfigService
  ) {}

  /** Increments this request's counter for the current window and route, and reports whether it's over budget. */
  async checkAbuse(
    req: Request,
    route: string,
    maxPerWindow: number = DEFAULT_ABUSE_MAX_PER_WINDOW,
    windowMs: number = DEFAULT_ABUSE_WINDOW_MS,
    now: number = Date.now()
  ): Promise<{ allowed: boolean }> {
    // The window is computed first because it is now an input to the fingerprint, not only its key.
    const windowStart = currentWindowStart(windowMs, now);
    const fingerprint = fingerprintRequest(
      req,
      windowStart,
      this.configService.get("abuseFingerprintKey", { infer: true })
    );
    const count = await this.abuseControl.incrementAbuseCounter(fingerprint, route, windowStart);
    return { allowed: count <= maxPerWindow };
  }
}
