/** E2E-SUB-09 — the asynchronous failure classifications. */
import { deploymentParameters, env } from "../../support/env.js";
import { fixture, fixtures, missingFixture, missingRunScopedTarget, submissionFor } from "../../support/fixtures.js";
import { caseBlock } from "../../support/gate.js";
import { expectStatus } from "../../support/http.js";
import { readJobLog, submitAndWait } from "../../support/job.js";
import {
  assertBuildLogContainsAny,
  assertBuildLogRedacted,
} from "../../support/log-assertions.js";
import { ownEntryOf, ownVerifierIdentity, readStatusObject } from "../../support/result-tree.js";

async function ownPublishedEntry(wasmHash: string): Promise<string | undefined> {
  const status = await readStatusObject(wasmHash);
  if (!status.found) return undefined;
  const own = ownEntryOf(status.object.source_code_verifications, await ownVerifierIdentity());
  return own ? JSON.stringify(own) : undefined;
}

async function assertFailureDidNotPublish(
  before: string | undefined,
  wasmHash: string,
  result: { artifact_url?: string; matched?: boolean } | undefined
): Promise<void> {
  expect(result?.artifact_url).toBeUndefined();
  expect(result?.matched).toBeUndefined();
  expect(await ownPublishedEntry(wasmHash)).toBe(before);
}

caseBlock(
  {
    id: "E2E-SUB-09/source_unreachable",
    title: "an unreachable source fails asynchronously and never publishes a claim",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () =>
      missingFixture("F-LEG-1") ??
      (fixtures.unreachable_source_uri
        ? undefined
        : "fixture inventory has no guaranteed-404 unreachable_source_uri"),
  },
  () => {
    it("creates a job, returns source_unreachable evidence, and preserves publication", async () => {
      const target = fixture("F-LEG-1");
      const before = await ownPublishedEntry(target.wasm_hash!);
      const run = await submitAndWait(
        await submissionFor("F-LEG-1", { source_uri: fixtures.unreachable_source_uri! })
      );

      // A vocabulary drift must cost one assertion, not the case.
      expect(run.jobId).toEqual(expect.any(String));
      expect(run.body.status).toBe("source_unavailable");
      // Independent of which code is in play: whatever `error` says, `result.reason` says the same.
      expect(run.body.result?.reason).toBe(run.body.error);

      await assertFailureDidNotPublish(before, target.wasm_hash!, run.body.result);

      const log = await readJobLog(run.jobId);
      expectStatus(log, 200, 404);
      if (log.status === 200) {
        assertBuildLogRedacted(log.text);
        assertBuildLogContainsAny(log.text, "source retrieval", [
          /source[_ -]?uri/i,
          /materializ/i,
          /fetch/i,
          /404/,
        ]);
      } else {
        // A pre-builder failure is expected to have no log. Still validate the stable envelope so a missing
        // object is not confused with an unrelated route or authorization failure.
        expect(log.json?.error).toBe("not_found");
        expect(log.json?.failure_reason).toBe("source_unreachable");
      }

      // Last, and on its own: source materialisation happens in orchestrator-svc before a Batch job is
      // dispatched, and its public detail is intentionally generic.
      expect(run.body.error).toBe("source_uri_not_materialized");
    }, env.jobTimeoutMs + 60_000);
  }
);

caseBlock(
  {
    id: "E2E-SUB-09/build_failed",
    title: "a real compiler error is a permanent build failure and never published",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-PRIV-BUILDFAILED"),
  },
  () => {
    it("runs rustc, returns build_failed, preserves publication and retains the compiler error", async () => {
      const target = fixture("F-PRIV-BUILDFAILED");
      const before = await ownPublishedEntry(target.wasm_hash!);
      const run = await submitAndWait(await submissionFor("F-PRIV-BUILDFAILED"));

      expect(run.body.status).toBe("build_failed");
      expect(run.body.error).toBe("rebuild_command_failed");
      expect(run.body.result?.reason).toBe(run.body.error);
      await assertFailureDidNotPublish(before, target.wasm_hash!, run.body.result);

      const log = await readJobLog(run.jobId);
      expectStatus(log, 200);
      assertBuildLogRedacted(log.text);
      assertBuildLogContainsAny(log.text, "rustc compiler error", [
        /error(?:\[E\d+\])?:/i,
        /could not compile/i,
        /not valid rust/i,
      ]);
    }, env.jobTimeoutMs + 60_000);
  }
);

caseBlock(
  {
    id: "E2E-SUB-09/build_timeout",
    title: "an infinite build is stopped by LIMIT_WALLCLOCK and classified as retryable",
    mode: "AUTO-SLOW",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () =>
      missingFixture("F-BUILD-TIMEOUT") ??
      missingRunScopedTarget("F-SUB09-TIMEOUT") ??
      (deploymentParameters.limitWallclockMs
        ? undefined
        : "📐 LIMIT_WALLCLOCK is not published; set SCVS_E2E_LIMIT_WALLCLOCK_MS from deployment evidence"),
  },
  () => {
    it("times out, preserves publication and retains the timeout status through termination", async () => {
      const target = fixture("F-SUB09-TIMEOUT");
      const before = await ownPublishedEntry(target.wasm_hash!);
      const limit = deploymentParameters.limitWallclockMs!;
      const run = await submitAndWait(await submissionFor("F-BUILD-TIMEOUT", {
        target: { contract_id: target.contract_id },
      }), {
        timeoutMs: Math.max(env.jobTimeoutMs, limit * 2),
        requireFreshTargetJob: true,
      });

      expect(run.body.status).toBe("build_failed");
      // The public error code is the builder's raw command outcome. The trusted side derives the retryable
      // `build_timeout` classification from the diagnostics instead of rewriting it.
      expect(run.body.error).toBe("rebuild_command_failed");
      expect(run.body.result?.reason).toBe(run.body.error);
      expect(run.body.result?.sandbox_diagnostics).toEqual(
        expect.objectContaining({ timed_out: true })
      );
      expect(run.wallClockMs).toBeGreaterThanOrEqual(limit);
      await assertFailureDidNotPublish(before, target.wasm_hash!, run.body.result);

      const log = await readJobLog(run.jobId);
      expectStatus(log, 200);
      assertBuildLogRedacted(log.text);
      // Cargo does not promise to forward a still-running build script's stderr when its parent is terminated.
      assertBuildLogContainsAny(log.text, "timed-out command", [/\[timed out\]/]);
    }, Math.max(env.jobTimeoutMs, (deploymentParameters.limitWallclockMs ?? 0) * 2) + 60_000);
  }
);
