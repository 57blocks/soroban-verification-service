import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ScvsLogger } from "@scvs/core";
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

/**
 * Identifies a submitter for as long as a connection might stay open, without storing a reversible value:
 * HMAC-SHA-256 of `req.ip` under the same deployment secret `fingerprintRequest` uses. Unlike that function,
 * this has no window bound into the input — it backs `StreamConcurrencyLimiter`'s per-IP concurrency ceiling,
 * which counts connections open *right now*, not requests over a window, so the same address must map to the
 * same key for the life of a stream rather than rotating out from under an open connection.
 */
export function fingerprintIp(req: Request, key: string): string {
  const identity = req.ip || req.socket.remoteAddress || "unknown";
  return createHmac("sha256", key).update(identity).digest("hex");
}

/** Only reached by a caller that omits the threshold — see `checkAbuseFailOpen`. */
export const DEFAULT_FAILOPEN_THRESHOLD = 10;

/**
 * `checkAbuseFailOpen`'s verdict: `allowed` covers both "under budget" and "the check itself failed, so we're
 * admitting it" — those two only ever differ in the log line already written by the time a caller sees this.
 * `fail_closed` is the one a caller must treat differently: the check has been failing so persistently that
 * this instance has stopped trusting "fail open" as a safe default.
 */
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

/**
 * The status code and body a rejected `AbuseCheckResult` maps to — the one place both `checkAbuseFailOpen`
 * callers (the guard, the middleware) get this mapping from, so it can only drift in one place. Each caller
 * still sends the response its own way (`ApiError` vs `res.status().json()`), which is why this returns the
 * pieces rather than sending anything itself.
 */
export function abuseCheckError(
  result: Extract<AbuseCheckResult, { allowed: false }>,
): { statusCode: 429 | 503; detail: typeof RATE_LIMITED_ERROR | typeof FAIL_CLOSED_ERROR } {
  return result.reason === "fail_closed"
    ? { statusCode: 503, detail: FAIL_CLOSED_ERROR }
    : { statusCode: 429, detail: RATE_LIMITED_ERROR };
}

@Injectable()
export class AbuseGuardService {
  /**
   * Per-instance, in-memory, and deliberately not shared across replicas: coordinating it (e.g. through
   * Postgres) would make the escalation depend on the very thing that's failing. With N replicas each counts
   * independently, so the fail-closed transition staggers across instances rather than landing at once — still
   * converges to protection within a few threshold windows, which is the tradeoff this makes.
   */
  private consecutiveFailOpens = 0;

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

  /**
   * `checkAbuse`, wrapped so a database failure fails open rather than taking the route down — deliberate,
   * which is why it must be loud: the log line this writes is the only sign the quota stopped being enforced.
   * Shared by every caller of `checkAbuse` so the fail-open behavior can only drift in one place.
   *
   * Unconditional fail-open is itself a hazard once the database is genuinely down rather than merely slow: a
   * flood of admitted requests each issues more database queries, which is the reinforcing loop this guards
   * against. Past `failOpenThreshold` consecutive failures (with no intervening success), the guard stops
   * failing open and fails closed instead — a 503 the caller can distinguish from `rate_limited` and retry
   * with different semantics for.
   */
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
        // Not "failed repeatedly": with a threshold of 0, consecutive_failures is 1 here.
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
