import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectStatus } from "../../support/http.js";
import { readJobLog, submitAndWait } from "../../support/job.js";
import { assertBuildLogContainsAny, assertBuildLogRedacted } from "../../support/log-assertions.js";
import { readReportByUrl } from "../../support/result-tree.js";

caseBlock(
  {
    id: "E2E-SUB-18/dry_run",
    title: "a dry run returns a verdict and redacted log without publishing, then a real submission publishes",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it(
      "keeps the dry-run result private while allowing the identical recipe to publish later",
      async () => {
        // Both calls must stay in this one Jest test to share its test-scoped recipe.
        const body = await submissionFor("F-LEG-1");
        const dryRun = await submitAndWait({ ...body, dry_run: true });

        expect(dryRun.body.status).toBe("verified");
        expect(dryRun.body.result?.matched).toBe(true);
        expect(dryRun.body.result?.rebuilt_wasm_hash).toBe(dryRun.body.result?.wasm_hash);

        expect(dryRun.body.result?.artifact_url).toBeUndefined();
        expect(dryRun.body.result?.artifact_sha256).toBeUndefined();
        expect(dryRun.body.result?.arweave_tx_id).toBeUndefined();

        const dryLog = await readJobLog(dryRun.jobId);
        expectStatus(dryLog, 200);
        assertBuildLogRedacted(dryLog.text);
        assertBuildLogContainsAny(dryLog.text, "successful compilation or artifact", [
          /Compiling/i,
          /Finished/i,
          /verified_demo/i,
          /\.wasm\b/i,
        ]);

        const published = await submitAndWait(body);
        expect(published.body.status).toBe("verified");
        expect(published.body.result?.matched).toBe(true);
        expect(published.body.result?.artifact_url).toBeDefined();
        expect(published.body.result?.artifact_sha256).toBeDefined();
        await readReportByUrl(published.body.result!.artifact_url!);
      },
      2 * env.jobTimeoutMs + 120_000
    );
  }
);
