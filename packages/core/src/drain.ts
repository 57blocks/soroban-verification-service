import { ScvsLogger } from "./logging.js";

export class DrainState {
  private drainingSince: string | undefined;

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

  get since(): string | undefined {
    return this.drainingSince;
  }
}

export type ReadinessReport = {
  ready: boolean;
  draining: boolean;
  draining_since?: string;
  checks: Record<string, ReadinessCheck>;
};

export type ReadinessCheck = { ok: boolean; detail?: string };

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
