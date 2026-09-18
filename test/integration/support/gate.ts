/** Skips, with a reason. */
import { env, type ExecutionMode } from "./env.js";

export interface CaseRequirements {
  /** `E2E-SUB-05/tag_only`. */
  readonly id: string;
  /** One line, from the case's own title. */
  readonly title: string;
  readonly mode: ExecutionMode;
  /** Environment variables whose absence makes the case unrunnable. */
  readonly needs?: readonly (string | undefined)[];
  readonly prerequisites?: readonly string[];
  /** A precondition the harness can only evaluate at module load, e.g. a fixture being registered. */
  readonly unless?: () => string | undefined;
}

function missingReason(requirements: CaseRequirements): string | undefined {
  if (!env.enabled) {
    return "SCVS_E2E is not set — this suite drives a real deployment and never runs by default";
  }

  if (requirements.mode === "MANUAL" || requirements.mode === "BROWSER") {
    return `execution mode ${requirements.mode} is not automatable in this package`;
  }
  if (requirements.mode === "AUTO" && env.autoScope === "slow") {
    return "AUTO is not selected by SCVS_E2E_AUTO_SCOPE=slow";
  }
  if (requirements.mode === "AUTO-SLOW" && env.autoScope === "auto") {
    return "AUTO-SLOW is not selected; set SCVS_E2E_AUTO_SCOPE=slow or all";
  }
  if (requirements.mode === "AUTO-INFRA" && !env.allowInfra) {
    return "AUTO-INFRA changes deployment state; set SCVS_E2E_ALLOW_INFRA=1 in a dedicated window";
  }
  if (requirements.mode === "PERF" && !env.allowPerf) {
    return "PERF consumes shared build capacity; run a Locust performance command or set SCVS_E2E_ALLOW_PERF=1";
  }
  const absent = (requirements.needs ?? []).filter(
    (name) => name !== undefined && !process.env[name]
  );
  if (absent.length > 0) return `missing ${absent.join(", ")}`;

  return requirements.unless?.();
}

/** Declares a case. */
export function caseBlock(requirements: CaseRequirements, body: () => void): void {
  const reason = missingReason(requirements);
  const label = `${requirements.id} — ${requirements.title} [${requirements.mode}]`;

  if (reason) {
    describe.skip(`${label} · SKIPPED: ${reason}`, body);
    return;
  }
  describe(label, body);
}

/** For a single row inside a table-driven case whose own precondition is missing. */
export function rowTest(
  name: string,
  reason: string | undefined,
  fn: () => Promise<void> | void,
  timeoutMs?: number
): void {
  if (reason) {
    it.skip(`${name} · SKIPPED: ${reason}`, fn as never);
    return;
  }
  it(name, fn as never, timeoutMs);
}
