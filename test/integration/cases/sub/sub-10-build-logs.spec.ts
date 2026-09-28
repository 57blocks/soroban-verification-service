import { deploymentParameters, env } from "../../support/env.js";
import { fixture, missingFixture, missingRunScopedTarget, submissionFor } from "../../support/fixtures.js";
import { caseBlock } from "../../support/gate.js";
import { expectStatus } from "../../support/http.js";
import { readJobLog, submitAndWait } from "../../support/job.js";
import {
  assertBuildLogContainsAny,
  assertBuildLogRedacted,
} from "../../support/log-assertions.js";

interface LogCase {
  readonly suffix: string;
  readonly fixtureId: string;
  readonly expectedStatus: "verified" | "mismatch" | "build_failed";
  readonly contentLabel: string;
  readonly contentPatterns: readonly RegExp[];
  readonly requiresWallclock?: boolean;
}

const cases: readonly LogCase[] = [
  {
    suffix: "verified",
    fixtureId: "F-LEG-1",
    expectedStatus: "verified",
    contentLabel: "successful compilation or artifact",
    contentPatterns: [/Compiling/i, /Finished/i, /verified_demo/i, /\.wasm\b/i],
  },
  {
    suffix: "mismatched",
    fixtureId: "F-LEG-3",
    expectedStatus: "mismatch",
    contentLabel: "mismatched build compilation or artifact",
    contentPatterns: [/Compiling/i, /Finished/i, /verified_demo/i, /\.wasm\b/i],
  },
  {
    suffix: "build_failed",
    fixtureId: "F-PRIV-BUILDFAILED",
    expectedStatus: "build_failed",
    contentLabel: "rustc compiler error",
    contentPatterns: [/error(?:\[E\d+\])?:/i, /could not compile/i, /not valid rust/i],
  },
  {
    suffix: "build_timeout",
    fixtureId: "F-BUILD-TIMEOUT",
    expectedStatus: "build_failed",
    // Cargo need not forward a running build script's stderr once its parent is killed.
    contentLabel: "timed-out command",
    contentPatterns: [/\[timed out\]/],
    requiresWallclock: true,
  },
];

for (const row of cases) {
  caseBlock(
    {
      id: `E2E-SUB-10/${row.suffix}`,
      title: `${row.suffix} has a complete build log with no boundary secrets`,
      mode: row.requiresWallclock ? "AUTO-SLOW" : "AUTO",
      needs: ["SCVS_E2E_VERIFY_URL"],
      prerequisites: ["P1"],
      unless: () =>
        missingFixture(row.fixtureId) ??
        (row.requiresWallclock ? missingRunScopedTarget("F-SUB10-TIMEOUT") : undefined) ??
        (row.requiresWallclock && !deploymentParameters.limitWallclockMs
          ? "📐 LIMIT_WALLCLOCK is not published; set SCVS_E2E_LIMIT_WALLCLOCK_MS from deployment evidence"
          : undefined),
    },
    () => {
      it("returns real state-specific content and no credentials, upload targets, local paths or internal hosts", async () => {
        const timeout = row.requiresWallclock
          ? Math.max(env.jobTimeoutMs, deploymentParameters.limitWallclockMs! * 2)
          : env.jobTimeoutMs;
        const target = row.requiresWallclock ? fixture("F-SUB10-TIMEOUT") : undefined;
        const body = await submissionFor(
          row.fixtureId,
          target ? { target: { contract_id: target.contract_id } } : undefined,
        );
        const run = await submitAndWait(body, {
          timeoutMs: timeout,
          requireFreshTargetJob: row.suffix === "build_timeout",
          // build_timeout is retryable; settling would read the retry instead.
          settleMs: row.suffix === "build_timeout" ? 0 : undefined,
        });
        expect(run.body.status).toBe(row.expectedStatus);

        if (row.suffix === "verified") expect(run.body.result?.matched).toBe(true);
        if (row.suffix === "mismatched") {
          expect(run.body.result?.matched).toBe(false);
          expect(run.body.result?.rebuilt_wasm_hash).toBeDefined();
          expect(run.body.result?.rebuilt_wasm_hash).not.toBe(run.body.result?.wasm_hash);
        }
        if (row.suffix === "build_failed") expect(run.body.error).toBe("rebuild_command_failed");
        if (row.suffix === "build_timeout") {
          expect(run.body.error).toBe("rebuild_command_failed");
          expect(run.body.result?.sandbox_diagnostics).toEqual(
            expect.objectContaining({ timed_out: true }),
          );
        }

        const log = await readJobLog(run.jobId);
        expectStatus(log, 200);
        assertBuildLogRedacted(log.text);
        assertBuildLogContainsAny(log.text, row.contentLabel, row.contentPatterns);
      }, Math.max(env.jobTimeoutMs, (deploymentParameters.limitWallclockMs ?? 0) * 2) + 60_000);
    }
  );
}
