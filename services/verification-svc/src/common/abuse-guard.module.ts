import { Global, Module } from "@nestjs/common";
import { AbuseGuardService } from "./abuse-guard.js";

/**
 * Global, like `DrainModule`: `AbuseGuardService` carries the fail-closed escalation's consecutive-failure
 * counter, and `PreflightModule` and `VerificationsModule` both need `AbuseGuard`/`RawArchiveBodyMiddleware`
 * to see the same one — a per-module registration would give each route group its own counter and its own
 * threshold, splitting one circuit breaker into two that trip independently.
 */
@Global()
@Module({
  providers: [AbuseGuardService],
  exports: [AbuseGuardService],
})
export class AbuseGuardModule {}
