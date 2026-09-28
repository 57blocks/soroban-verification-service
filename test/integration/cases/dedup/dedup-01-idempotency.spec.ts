import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { missingFixture, submissionFor } from "../../support/fixtures.js";
import { evaluateNoSecondBuild, expectNoSecondBuild, observeBuild } from "../../support/dedup.js";
import { submitAndWait } from "../../support/job.js";
import { reportForJob } from "../../support/result-tree.js";

caseBlock(
  {
    id: "E2E-DEDUP-01",
    title: "the same recipe submitted twice reuses the first build",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it(
      "second submission satisfies all three `no second build` conditions",
      async () => {
        const body = await submissionFor("F-LEG-1");

        const firstRun = await submitAndWait(body);
        const firstReport = await reportForJob(firstRun.body.result, firstRun.body.result?.wasm_hash);
        const first = await observeBuild(firstRun.jobId, firstRun, firstReport?.artifact);

        const secondRun = await submitAndWait(body);
        const secondReport = await reportForJob(
          secondRun.body.result,
          secondRun.body.result?.wasm_hash
        );
        const second = await observeBuild(secondRun.jobId, secondRun, secondReport?.artifact);

        expect(secondRun.jobId).not.toBe(firstRun.jobId);

        expectNoSecondBuild(evaluateNoSecondBuild(first, second));

        expect(secondRun.body.status).toBe(firstRun.body.status);
      },
      2 * env.jobTimeoutMs + 120_000
    );
  }
);
