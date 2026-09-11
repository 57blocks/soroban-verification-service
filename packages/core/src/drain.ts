import { ScvsLogger } from "./logging.js";

/**
 * The accept-off switch a graceful shutdown needs — O9's draining runbook, and the reason it could not be
 * written before this existed.
 */
export class DrainState {
  private drainingSince: string | undefined;

  /**
   * Idempotent: SIGTERM can arrive twice, and a second call must not restart the clock or produce a second log
   * record.
   */
  beginDrain(now: string, logger?: ScvsLogger): boolean {
    if (this.drainingSince !== undefined) return false;
    this.drainingSince = now;
    logger?.warn(
      "draining: refusing new work, letting in-flight work finish. Status reads stay served",
      { draining_since: now },
    );
    return true;
  }

  get isDraining(): boolean {
    return this.drainingSince !== undefined;
  }

  /** ISO-8601, or `undefined` when not draining. Reported by the readiness probe so an operator can see *when*. */
  get since(): string | undefined {
    return this.drainingSince;
  }
}

/** What a readiness probe answers with. `checks` is diagnostic; `ready` is what an orchestrator reads. */
export type ReadinessReport = {
  ready: boolean;
  draining: boolean;
  draining_since?: string;
  /**
   * Per-dependency results. A `false` here is what made `ready` false; a dependency that is deliberately
   * **not** probed is absent rather than reported as passing — see `readiness()`.
   */
  checks: Record<string, ReadinessCheck>;
};

export type ReadinessCheck = { ok: boolean; detail?: string };

/** Composes a readiness answer. */
export function readiness(
  drain: DrainState,
  checks: Record<string, ReadinessCheck>,
): ReadinessReport {
  const failed = Object.values(checks).some((check) => !check.ok);
  return {
    ready: !drain.isDraining && !failed,
    draining: drain.isDraining,
    ...(drain.since ? { draining_since: drain.since } : {}),
    checks,
  };
}
