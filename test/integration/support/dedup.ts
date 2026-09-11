/** The DEDUP group's substitute criterion for "no second build". */
import { sha256Hex } from "./http.js";
import { readJobLog, RULE_D_REQUEUE_DETAIL } from "./job.js";
import type { RequeueWatch, TerminalJob } from "./job.js";
import type { VerificationArtifact } from "./types.js";

export interface BuildObservation {
  readonly jobId: string;
  readonly terminal: TerminalJob;
  readonly artifact?: VerificationArtifact;
  /** Whether `artifact` is this job's own publication. */
  readonly artifactIsOwn: boolean;
  readonly logSha256?: string;
  readonly logAvailable: boolean;
}

export async function observeBuild(
  jobId: string,
  terminal: TerminalJob,
  artifact?: VerificationArtifact
): Promise<BuildObservation> {
  const log = await readJobLog(jobId);
  const logAvailable = log.status === 200;
  const artifactIsOwn = Boolean(terminal.body.result?.artifact_url);
  return {
    jobId,
    terminal,
    artifact: artifactIsOwn ? artifact : undefined,
    artifactIsOwn,
    logAvailable,
    logSha256: logAvailable ? sha256Hex(log.bytes) : undefined,
  };
}

export interface NoSecondBuildVerdict {
  readonly holds: boolean;
  readonly conditions: {
    readonly fasterThanOneFifth: boolean | undefined;
    readonly sameRebuiltArtifact: boolean | undefined;
    readonly identicalLogs: boolean | undefined;
  };
  /** Human-readable, and attached verbatim to the assertion message. */
  readonly explanation: string;
}

export function evaluateNoSecondBuild(
  first: BuildObservation,
  second: BuildObservation
): NoSecondBuildVerdict {
  const t1 = first.terminal.wallClockMs;
  const t2 = second.terminal.wallClockMs;
  const fasterThanOneFifth = t2 < 0.2 * t1;
  const firstHash = first.artifact?.result?.rebuilt_wasm_hash;
  const secondHash = second.artifact?.result?.rebuilt_wasm_hash;
  const sameRebuiltArtifact =
    firstHash === undefined || secondHash === undefined ? undefined : firstHash === secondHash;

  const identicalLogs =
    first.logAvailable && second.logAvailable ? first.logSha256 === second.logSha256 : undefined;

  const unowned = [
    first.artifactIsOwn ? undefined : `${first.jobId} (${first.terminal.body.status})`,
    second.artifactIsOwn ? undefined : `${second.jobId} (${second.terminal.body.status})`,
  ].filter((entry): entry is string => entry !== undefined);

  const notes = [
    `T1=${t1}ms, T2=${t2}ms (reuse window T2 < ${Math.round(0.2 * t1)}ms) → ${fasterThanOneFifth ? "inside" : "outside"}`,
    sameRebuiltArtifact === undefined
      ? unowned.length > 0
        ? `rebuilt hash: not comparable — published no artifact of its own: ${unowned.join(", ")}. ` +
          `That job reached a terminal state without publishing, so it has no rebuilt hash to compare ` +
          `and this pair proves nothing about reuse either way.`
        : "rebuilt hash: not comparable — one or both reports were unavailable"
      : `rebuilt hash ${firstHash} vs ${secondHash} → ${sameRebuiltArtifact ? "pass" : "FAIL"}`,
    identicalLogs === undefined
      ? "logs: not comparable — one or both jobs recorded no log (diagnostic only)"
      : `log sha256 ${first.logSha256} vs ${second.logSha256} → ${identicalLogs ? "pass" : "FAIL"}`,
  ];

  return {
    holds: sameRebuiltArtifact === true,
    conditions: { fasterThanOneFifth, sameRebuiltArtifact, identicalLogs },
    explanation: notes.join("\n  · "),
  };
}

export function expectNoSecondBuild(verdict: NoSecondBuildVerdict): void {
  if (verdict.holds) return;
  throw new Error(`"no second build" does not hold:\n  · ${verdict.explanation}`);
}

export function expectSecondBuildHappened(verdict: NoSecondBuildVerdict): void {
  // Different source bytes can legitimately produce the same Wasm.
  if (
    verdict.conditions.fasterThanOneFifth === false ||
    verdict.conditions.sameRebuiltArtifact === false ||
    verdict.conditions.identicalLogs === false
  ) return;
  throw new Error(
    `expected evidence of a new build, but every available observation looked like reuse:\n  · ${verdict.explanation}`
  );
}

/**
 * Deliberately asymmetric in what counts as evidence, for the same reason `expectSecondBuildHappened` is: the
 * two directions are not observable with equal confidence.
 */
export function expectRequeued(watch: RequeueWatch, label: string): void {
  if (watch.requeues > 0 || watch.sawRequeueMarker) return;
  throw new Error(
    `${label}: expected §7.6 Rule D to re-queue this job at least once, and observed neither a ` +
      `terminal→non-terminal transition nor the "${RULE_D_REQUEUE_DETAIL}" progress marker.\n` +
      `  · ${watch.explanation}\n` +
      `  · If the deployment's SCVS_JOB_RETRY_INTERVAL_MS is longer than the watch window, raise ` +
      `SCVS_E2E_DEDUP06_WATCH_MS rather than weakening this assertion.`
  );
}

export function expectNoRequeue(watch: RequeueWatch, label: string): void {
  const moved = watch.updatedAtSequence.length > 1;
  if (!moved && watch.requeues === 0 && !watch.sawRequeueMarker) return;
  throw new Error(
    `${label}: §7.6 Rule D must not re-queue a non-retryable failure, but the job changed after ` +
      `reaching its terminal state.\n  · ${watch.explanation}`
  );
}
