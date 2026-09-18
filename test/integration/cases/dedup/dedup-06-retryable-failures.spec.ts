import { deploymentParameters, env, retryPolicyProvenance } from "../../support/env.js";
import {
  fixture,
  fixtures,
  missingFixture,
  missingRunScopedTarget,
  sourceOf,
  submissionFor,
} from "../../support/fixtures.js";
import { caseBlock } from "../../support/gate.js";
import { expectNoRequeue } from "../../support/dedup.js";
import {
  readJob,
  submitAccepted,
  submitAndWait,
  waitForTerminal,
  watchPastTerminal,
} from "../../support/job.js";
import { readDedup06InternalErrorEvidence } from "../../support/sub-infra-evidence.js";

function retryPolicyProblem(): string | undefined {
  const { jobRetryIntervalMs, maxJobRetryAttempts } = deploymentParameters;
  if (!jobRetryIntervalMs || !maxJobRetryAttempts) {
    return `📐 Rule D retry policy is unavailable: ${retryPolicyProvenance.interval}; ${retryPolicyProvenance.maxAttempts}`;
  }
  return undefined;
}

/** One scan plus enough samples to see its public row update. */
function retryWatchWindowMs(): number {
  return deploymentParameters.jobRetryIntervalMs! + env.pollIntervalMs * 4;
}

function assertRequeued(watch: Awaited<ReturnType<typeof watchPastTerminal>>): void {
  expect(watch.requeues).toBeGreaterThanOrEqual(1);
  // `progress.detail` is a current-state snapshot, so dispatch can replace the requeue message before a poll
  // sees it.
  expect(watch.updatedAtSequence.length).toBeGreaterThanOrEqual(2);
}

function assertAwaitingRetryDispatch(watch: Awaited<ReturnType<typeof watchPastTerminal>>): void {
  expect(watch.endedTerminal).toBe(false);
  // The database transition is `failed -> queued`, but the public polling endpoint can observe the next
  // orchestrator tick already dispatching it.
  expect(["queued", "running"]).toContain(watch.body.status);
}

caseBlock(
  {
    id: "E2E-DEDUP-06/build_timeout_requeued",
    title: "a wall-clock timeout is re-queued through the public Rule D transition",
    mode: "AUTO-SLOW",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () =>
      missingFixture("F-BUILD-TIMEOUT") ??
      missingRunScopedTarget("F-RULE-D-TIMEOUT") ??
      (deploymentParameters.limitWallclockMs
        ? retryPolicyProblem()
        : "📐 LIMIT_WALLCLOCK is not supplied as deployment evidence"),
  },
  () => {
    it(
      "moves from its first timeout failure into a live retry with Rule D evidence",
      async () => {
        const target = fixture("F-RULE-D-TIMEOUT");
        const submitted = await submitAccepted(
          await submissionFor("F-BUILD-TIMEOUT", { target: { contract_id: target.contract_id } }),
          { requireFreshTargetJob: true },
        );
        const watch = await watchPastTerminal(submitted.jobId, {
          windowMs: Math.max(env.jobTimeoutMs, deploymentParameters.limitWallclockMs! * 2) + retryWatchWindowMs(),
          stopOnFirstRequeue: true,
        });
        expect(watch.statusSequence).toContain("build_failed");
        assertRequeued(watch);
        assertAwaitingRetryDispatch(watch);
      },
      Math.max(env.jobTimeoutMs, deploymentParameters.limitWallclockMs! * 2) + retryWatchWindowMs() + 60_000,
    );
  },
);

caseBlock(
  {
    id: "E2E-DEDUP-06/non_retryable_returned_for_correction",
    title: "an unreachable source stays terminal, while corrected source bytes create a new job",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () =>
      missingFixture("F-LEG-1", "F-LEG-3") ??
      retryPolicyProblem() ??
      (fixtures.unreachable_source_uri ? undefined : "fixture inventory has no guaranteed-404 unreachable_source_uri"),
  },
  () => {
    it(
      "does not re-queue source_unreachable, then accepts changed source bytes as a new build",
      async () => {
        // F-BUILD-TIMEOUT shares F-LEG-1's target and can still be retrying after its AUTO row.
        const unreachable = await submissionFor("F-LEG-3", {
          source_uri: fixtures.unreachable_source_uri!,
        });
        const failed = await submitAndWait(unreachable);
        expect(failed.body.status).toBe("source_unavailable");
        expect(failed.body.result?.reason).toBe(failed.body.error);

        const watch = await watchPastTerminal(failed.jobId, { windowMs: retryWatchWindowMs() });
        expect(watch.statusSequence[0]).toBe("source_unavailable");
        expectNoRequeue(watch, "E2E-DEDUP-06/non_retryable_returned_for_correction");
        expect(watch.endedTerminal).toBe(true);
        expect(watch.body.status).toBe("source_unavailable");

        const corrected = await submissionFor("F-LEG-3", await sourceOf("F-LEG-1"));

        // "Corrected" has to mean corrected: a reachable location AND changed bytes.
        expect(corrected.manifest.source_uri).not.toBe(unreachable.manifest.source_uri);
        expect(corrected.manifest.source_sha256).not.toBe(unreachable.manifest.source_sha256);

        const correctedRun = await submitAndWait(corrected);
        expect(correctedRun.jobId).not.toBe(failed.jobId);
        // F-LEG-1's known-good source cannot reproduce F-LEG-3's deployed Wasm, so a real comparison must
        // finish with the valid mismatch verdict rather than reusing the failed job.
        expect(correctedRun.body.status).toBe("mismatch");

        // Last: the classified retrieval code for the guaranteed-404 URL.
        expect(failed.body.error).toBe("source_uri_not_materialized");
      },
      retryWatchWindowMs() + 2 * env.jobTimeoutMs + 120_000,
    );
  },
);

caseBlock(
  {
    id: "E2E-DEDUP-06/internal_error_requeued",
    title: "a restored infrastructure fault re-queues its failed job and reaches the recorded verdict",
    mode: "AUTO-INFRA",
    needs: [
      "SCVS_E2E_VERIFY_URL",
      "SCVS_E2E_DEDUP06_INTERNAL_ERROR_EVIDENCE_PATH",
    ],
    prerequisites: ["P1", "P6"],
    unless: retryPolicyProblem,
  },
  () => {
    it(
      "observes failed -> queued after restoration, then a successful retry",
      async () => {
        const evidence = readDedup06InternalErrorEvidence();
        const failed = await readJob(evidence.jobId);
        expect(failed.status).toBe("build_failed");
        expect(failed.error).toBe(evidence.expectedErrorCode);
        expect(Date.parse(failed.created_at)).toBeGreaterThanOrEqual(evidence.appliedAtMs);
        expect(Date.parse(failed.updated_at)).toBeGreaterThanOrEqual(evidence.failedAtMs);

        const watch = await watchPastTerminal(evidence.jobId, {
          windowMs: retryWatchWindowMs(),
          stopOnFirstRequeue: true,
        });
        assertRequeued(watch);
        assertAwaitingRetryDispatch(watch);

        const retried = await waitForTerminal(evidence.jobId, { timeoutMs: env.jobTimeoutMs });
        expect(retried.body.status).toBe(evidence.expectedTerminalStatus);
        expect(retried.body.error).toBeUndefined();
      },
      retryWatchWindowMs() + env.jobTimeoutMs + 60_000,
    );
  },
);
