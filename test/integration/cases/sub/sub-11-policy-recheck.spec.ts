/** E2E-SUB-11 — image policy is re-evaluated after queueing and before dispatch. */
import { caseBlock } from "../../support/gate.js";
import { expectStatus } from "../../support/http.js";
import { readJob, readJobLog } from "../../support/job.js";
import { assertBuildLogRedacted } from "../../support/log-assertions.js";
import { readSub11Evidence } from "../../support/sub-infra-evidence.js";

caseBlock(
  {
    id: "E2E-SUB-11",
    title: "a queued image removed by redeploy is rejected before any build starts",
    mode: "AUTO-INFRA",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_SUB11_EVIDENCE_PATH"],
    prerequisites: ["P1", "P10"],
  },
  () => {
    it("binds the policy transition to the job and observes no cargo or rustc execution", async () => {
      const evidence = readSub11Evidence();
      expect(evidence.policyRestrictedSha256).not.toBe(evidence.policyBeforeSha256);

      const job = await readJob(evidence.jobId);
      expect(Date.parse(job.created_at)).toBeLessThanOrEqual(evidence.policyChangedAtMs);
      expect(Date.parse(job.updated_at)).toBeGreaterThanOrEqual(evidence.dispatchResumedAtMs);
      expect(Date.parse(job.updated_at)).toBeLessThanOrEqual(evidence.restoredAtMs);
      expect(["policy_rejected", "not_attempted"]).toContain(job.status);
      expect(job.error).toBe(evidence.expectedErrorCode);
      expect(job.result?.artifact_url).toBeUndefined();
      expect(job.result?.matched).toBeUndefined();

      const log = await readJobLog(evidence.jobId);
      expectStatus(log, 200, 404);
      if (log.status === 200) {
        assertBuildLogRedacted(log.text);
        expect(/\b(?:cargo|rustc|Compiling|Finished)\b/i.test(log.text)).toBe(false);
      }
    });
  }
);
