import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingDeployedTarget, submissionFor } from "../../support/fixtures.js";
import { expectStatus } from "../../support/http.js";
import { preflight, readJobLog, submitAndWait } from "../../support/job.js";
import { readStatusObject } from "../../support/result-tree.js";

const CASE_ID = "E2E-SUB-09/unsupported_toolchain";
const FIXTURE_ID = "F-FLOOR-REFUSE";

const PERMANENT = "policy_rejected";
const RETRYABLE = "build_failed";

const PERMANENT_REASONS = ["toolchain_target_unavailable", "unaddressable_cliver"] as const;

const CLIVER_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const CLIVER_REV = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

function cliverIsAddressable(cliver: string): boolean {
  const separator = cliver.indexOf("#");
  if (separator < 0) return CLIVER_VERSION.test(cliver);
  return (
    CLIVER_VERSION.test(cliver.slice(0, separator)) && CLIVER_REV.test(cliver.slice(separator + 1))
  );
}

/** wasm32v1-none first shipped in Rust 1.84.0. */
function rsverBelowTargetFloor(rsver: string): boolean {
  const [major, minor] = rsver.split(".").map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major * 1000 + minor < 1 * 1000 + 84;
}

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

    let preflighted: { cliver: string; rsver: string } | undefined;

    it("preflight says `compose`, because classification cannot know — and that is not a defect", async () => {
      const response = await preflight({
        network: target.network,
        contract_id: target.contract_id,
        wasm_hash: target.wasm_hash,
      });
      expectStatus(response, 200);

      expect(response.json.build_environment?.kind).toBe("compose");

      const pair = response.json.build_environment?.intent?.pair;
      expect(pair?.cliver).toEqual(expect.any(String));
      expect(pair?.rsver).toEqual(expect.any(String));

      preflighted = { cliver: String(pair.cliver), rsver: String(pair.rsver) };
      const expected = expectedReasonFor(preflighted);
      expect(PERMANENT_REASONS).toContain(expected);

      expect(target.bldimg).toBeUndefined();
    });

    it(
      "★ the job ends `policy_rejected` with `toolchain_target_unavailable`, not the retryable arm",
      async () => {
        const run = await submitAndWait(await submissionFor(FIXTURE_ID));

        expect(run.jobId).toEqual(expect.any(String));

        expect(run.body.status).not.toBe("verified");
        expect(run.body.status).not.toBe(RETRYABLE);
        expect(run.body.status).toBe(PERMANENT);

        expect(PERMANENT_REASONS).toContain(run.body.error);
        const derived = preflighted ? expectedReasonFor(preflighted) : undefined;
        if (derived) expect(run.body.error).toBe(derived);
        expect(run.body.result?.reason).toBe(run.body.error);

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

        const log = await readJobLog(run.jobId);
        expect([200, 404]).toContain(log.status);
      },
      env.jobTimeoutMs + 30_000
    );
  }
);
