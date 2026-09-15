import { Injectable, type ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerLimitDetail } from "@nestjs/throttler";
import { ApiError } from "./api-error.exception.js";

/**
 * The in-process throttler, reshaped to answer in this service's error envelope: a bare `ThrottlerException`
 * is indistinguishable to `LegacyHttpExceptionFilter` and would leave as `request_failed`, while the other
 * public service's tier already refuses with `rate_limited`.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw new ApiError(429, {
      error: "rate_limited",
      // Names neither the tier nor the ceiling: that would hand a caller the shape of the budget to sit under.
      message: "Too many requests, please try again later.",
    });
  }
}
