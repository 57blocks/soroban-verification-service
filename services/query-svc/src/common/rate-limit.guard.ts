import { Injectable, type ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerLimitDetail } from "@nestjs/throttler";
import { ApiError } from "./api-error.exception.js";

/**
 * The in-process throttler, reshaped to answer in this service's error envelope.
 *
 * Without the override below a refusal leaves as `ThrottlerException`, which `LegacyHttpExceptionFilter`
 * cannot tell from any other `HttpException` and maps to `request_failed` — a code RC6 reserves for something
 * else, and the one verification-svc's DB-backed tier already spells `rate_limited`. The two public services
 * have to refuse in the same vocabulary or a client has to special-case which one it is talking to.
 *
 * ⚠️ This tier counts per client address, per process. It bounds what ONE caller can extract; it does not
 * bound this deployment's AGGREGATE outbound rate to Soroban RPC, which N instances x M callers can still
 * exceed. Bounding that needs a limiter on the egress side, not here.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw new ApiError(429, {
      error: "rate_limited",
      // Deliberately says nothing about which tier refused or what the ceiling is: the quotas are a bound on
      // abuse, and publishing them per-response hands a caller the exact shape of the budget to sit under.
      message: "Too many requests, please try again later.",
    });
  }
}
