import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectPerTrd } from "../../support/conformance.js";
import { submitAndWait } from "../../support/job.js";
import {
  assertHashNotYetVerifiedByUs,
  ownEntryOf,
  isOwnEntry,
  ownVerifierIdentity,
  reportForJob,
  requireStatusObject,
} from "../../support/result-tree.js";

caseBlock(
  {
    id: "E2E-SUB-06",
    title: "`mismatched` is a successful verification, published like any other",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-3"),
  },
  () => {
    it(
      "publishes, carries a rebuilt hash that differs from the target, and is spelled `mismatched`",
      async () => {
        const target = fixtures.contracts["F-LEG-3"];

        if (target.wasm_hash) {
          await assertHashNotYetVerifiedByUs(target.wasm_hash, "E2E-SUB-06");
        }

        const run = await submitAndWait(await submissionFor("F-LEG-3"));

        expect(run.body.status).toBe("mismatch");

        const wasmHash = run.body.result?.wasm_hash ?? target.wasm_hash!;
        const statusObject = await requireStatusObject(wasmHash);
        const ours = ownEntryOf(statusObject.source_code_verifications, await ownVerifierIdentity());
        expect(ours).toBeDefined();
        expect(ours!.status).toBe("mismatched");

        expectPerTrd("JOB_STATUS_VOCABULARY", "E2E-SUB-06", () => {
          expect(run.body.status).toBe("mismatched");
        });

        expect(ours!.rebuilt_hash).toBeDefined();
        expect(ours!.rebuilt_hash).not.toBe(wasmHash);

        expect(ours!.processed_at).toBeDefined();
        expect(Number.isNaN(Date.parse(ours!.processed_at!))).toBe(false);

        const report = await reportForJob(run.body.result, wasmHash);
        expect(report).toBeDefined();
        expect(report!.artifact.result.rebuilt_wasm_hash).toBe(ours!.rebuilt_hash);
        expect(report!.artifact.result.matched).toBe(false);

        expect(ours!.status).not.toBe("unverified");
      },
      env.jobTimeoutMs + 60_000
    );
  }
);

caseBlock(
  {
    id: "E2E-SUB-07/mismatch_no_retry",
    title: "a mismatch is final — one build, no second attempt",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-3"),
  },
  () => {
    it(
      "never re-enters a building state after producing a verdict",
      async () => {
        const run = await submitAndWait(await submissionFor("F-LEG-3"));
        expect(run.body.status).toBe("mismatch");

        const verdictIndex = run.statusSequence.findIndex((status) => ["mismatch", "verified"].includes(status));
        expect(verdictIndex).toBe(run.statusSequence.length - 1);

        const wasmHash = run.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-3"].wasm_hash!;
        const statusObject = await requireStatusObject(wasmHash);
        const identity = await ownVerifierIdentity();
        const ourEntries = statusObject.source_code_verifications.filter((entry) => isOwnEntry(entry, identity));
        const rebuiltHashes = new Set(ourEntries.map((entry) => entry.rebuilt_hash).filter(Boolean));
        expect(rebuiltHashes.size).toBe(1);
      },
      env.jobTimeoutMs + 60_000
    );
  }
);
