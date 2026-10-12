import { Injectable, type ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, type ThrottlerLimitDetail } from "@nestjs/throttler";
import { ApiError } from "./api-error.js";

@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw new ApiError(429, {
      error: "rate_limited",
      // Must not name the tier or the ceiling.
      message: "Too many requests, please try again later.",
    });
  }
}
