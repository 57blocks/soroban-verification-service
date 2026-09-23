import { CanActivate, Inject, Injectable } from "@nestjs/common";
import { DrainState } from "@scvs/core";
import { ApiError } from "@scvs/http";

/**
 * Refuses **new work** while the task is draining, and nothing else — O9's "stop accepting new jobs while
 * in-flight jobs finish".
 */
@Injectable()
export class DrainGuard implements CanActivate {
  // Explicit `@Inject()` — see preflight.controller.ts's comment.
  constructor(@Inject(DrainState) private readonly drain: DrainState) {}

  canActivate(): boolean {
    if (!this.drain.isDraining) return true;
    throw new ApiError(503, {
      error: "draining",
      message:
        "This instance is shutting down and is not accepting new submissions. Retry — the load " +
        "balancer will route you to another instance. Jobs already accepted are unaffected and their " +
        "status remains readable.",
    });
  }
}
