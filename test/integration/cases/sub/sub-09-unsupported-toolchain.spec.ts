/** E2E-SUB-09/unsupported_toolchain — a recorded toolchain the composer must permanently refuse */
import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingDeployedTarget, submissionFor } from "../../support/fixtures.js";
import { expectStatus } from "../../support/http.js";
import { preflight, readJobLog, submitAndWait } from "../../support/job.js";
import { readStatusObject } from "../../support/result-tree.js";

const CASE_ID = "E2E-SUB-09/unsupported_toolchain";
const FIXTURE_ID = "F-FLOOR-REFUSE";

/** `failure-reason.util.ts`'s two buckets, as they surface on the wire. */
const PERMANENT = "policy_rejected";
const RETRYABLE = "build_failed";

/**
 * The composition reasons that are permanent **and** reachable from a contract classification routes to
 * `compose`.
 */
const PERMANENT_REASONS = ["toolchain_target_unavailable", "unaddressable_cliver"] as const;

/** `parseCliver`'s shape rules, restated. */
const CLIVER_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const CLIVER_REV = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

function cliverIsAddressable(cliver: string): boolean {
  const separator = cliver.indexOf("#");
  if (separator < 0) return CLIVER_VERSION.test(cliver);
  return (
    CLIVER_VERSION.test(cliver.slice(0, separator)) && CLIVER_REV.test(cliver.slice(separator + 1))
  );
}

/** Rust shipped `wasm32v1-none` in 1.84.0, so anything below it cannot build what the CLI asks for. */
function rsverBelowTargetFloor(rsver: string): boolean {
  const [major, minor] = rsver.split(".").map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major * 1000 + minor < 1 * 1000 + 84;
}

/** What the chain says this contract must be refused for. `undefined` = it should verify, not be refused. */
function expectedReasonFor(pair: { cliver: string; rsver: string }): string | undefined {
  if (!cliverIsAddressable(pair.cliver)) return "unaddressable_cliver";
  if (rsverBelowTargetFloor(pair.rsver)) return "toolchain_target_unavailable";
  return undefined;
}

caseBlock(
  {
    id: CASE_ID,
    title: "a toolchain the composer must refuse is refused permanently, not retryably, and never published",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget(FIXTURE_ID),
  },
  () => {
    const target = fixtures.contracts[FIXTURE_ID];

    /** The pair preflight echoed, shared between the two tests. */
    let preflighted: { cliver: string; rsver: string } | undefined;

    it("preflight says `compose`, because classification cannot know — and that is not a defect", async () => {
      const response = await preflight({
        network: target.network,
        contract_id: target.contract_id,
        wasm_hash: target.wasm_hash,
      });
      expectStatus(response, 200);

      // `classifyBuildEnvironment` is a pure function with no network access.
      expect(response.json.build_environment?.kind).toBe("compose");

      // The fixture's premise: the pair the *chain* records is the refusable one.
      const pair = response.json.build_environment?.intent?.pair;
      expect(pair?.cliver).toEqual(expect.any(String));
      expect(pair?.rsver).toEqual(expect.any(String));

      // Derived rather than hard-coded, because the fixture is whichever contract discovery found.
      preflighted = { cliver: String(pair.cliver), rsver: String(pair.rsver) };
      const expected = expectedReasonFor(preflighted);
      expect(PERMANENT_REASONS).toContain(expected);

      // A `bldimg` would make this cli-58 and route it to `chain_named`, never reaching composition.
      expect(target.bldimg).toBeUndefined();
    });

    it(
      "★ the job ends `policy_rejected` with `toolchain_target_unavailable`, not the retryable arm",
      async () => {
        const run = await submitAndWait(await submissionFor(FIXTURE_ID));

        // ── Hard assertion 1: a job exists ──────────────────────────────────────────────────────
        // SUB-09's shape, and the reason this is not a SUB-08 suffix: the refusal is *not* knowable at
        // submission time, so a synchronous 4xx would be wrong.
        expect(run.jobId).toEqual(expect.any(String));

        // ── Hard assertion 2: the permanent arm ─────────────────────────────────────────────────
        // The whole case.
        expect(run.body.status).not.toBe("verified");
        expect(run.body.status).not.toBe(RETRYABLE);
        expect(run.body.status).toBe(PERMANENT);

        // ── Hard assertion 3: the reason reaches the submitter ──────────────────────────────────
        // Not decoration. `policy_rejected` alone tells a submitter "we refused" without saying that no amount
        // of resubmitting will change it.
        expect(PERMANENT_REASONS).toContain(run.body.error);
        const derived = preflighted ? expectedReasonFor(preflighted) : undefined;
        if (derived) expect(run.body.error).toBe(derived);
        expect(run.body.result?.reason).toBe(run.body.error);

        // ── Hard assertion 4: nothing is published ─────────────────────────────────────────────
        // No build ran, so there is nothing to say about whether this contract's source matches; publishing
        // anything here would assert a verdict that was never established.
        expect(run.body.result?.artifact_url).toBeUndefined();
        expect(run.body.result?.matched).toBeUndefined();

        const wasmHash = run.body.result?.wasm_hash ?? target.wasm_hash;
        if (wasmHash && wasmHash !== "unknown") {
          const published = await readStatusObject(wasmHash);
          if (published.found) {
            const ours = published.object.source_code_verifications ?? [];
            expect(ours.every((entry) => entry.status !== "mismatched")).toBe(true);
          }
        }

        // Diagnostic, not a hard assertion. `jobs.service.ts` 404s the log route when no build produced one,
        // which is the correct answer here — there was no build.
        const log = await readJobLog(run.jobId);
        expect([200, 404]).toContain(log.status);
      },
      // No build, no composition beyond one HTTP request to rustup's channel manifest.
      env.jobTimeoutMs + 30_000
    );
  }
);
