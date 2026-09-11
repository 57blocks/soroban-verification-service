/** E2E-SUB-06 — `mismatched` is a successful verification E2E-SUB-07/mismatch_no_retry — and it is final */
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

        // Precondition 2 — never verified.
        if (target.wasm_hash) {
          await assertHashNotYetVerifiedByUs(target.wasm_hash, "E2E-SUB-06");
        }

        const run = await submitAndWait(await submissionFor("F-LEG-3"));

        // HA1 — terminal, and not a failure.
        expect(run.body.status).toBe("mismatch");

        // HA2, on the *published* surface, where SO1's spelling applies and holds.
        const wasmHash = run.body.result?.wasm_hash ?? target.wasm_hash!;
        const statusObject = await requireStatusObject(wasmHash);
        const ours = ownEntryOf(statusObject.source_code_verifications, await ownVerifierIdentity());
        expect(ours).toBeDefined();
        expect(ours!.status).toBe("mismatched");

        // The job surface spells the same outcome `mismatch`. Recorded, not failed: SO1 governs the published
        // vocabulary and the published surface complies.
        expectPerTrd("JOB_STATUS_VOCABULARY", "E2E-SUB-06", () => {
          expect(run.body.status).toBe("mismatched");
        });

        // HA3 — SO2: a mismatch must say what it built, and it must differ from what is deployed.
        expect(ours!.rebuilt_hash).toBeDefined();
        expect(ours!.rebuilt_hash).not.toBe(wasmHash);

        // HA4 — SO3.
        expect(ours!.processed_at).toBeDefined();
        expect(Number.isNaN(Date.parse(ours!.processed_at!))).toBe(false);

        // HA5 — and the report agrees with the status object. A rebuilt hash that differed between the two
        // would mean the published record and its evidence disagree.
        const report = await reportForJob(run.body.result, wasmHash);
        expect(report).toBeDefined();
        expect(report!.artifact.result.rebuilt_wasm_hash).toBe(ours!.rebuilt_hash);
        expect(report!.artifact.result.matched).toBe(false);

        // Diagnostic from the case: a run with no rebuilt hash is `unverified`, not `mismatched` (SO6).
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

        // HA1/HA2, as far as the public surface can express them.
        const terminalIndex = run.statusSequence.findIndex((status) =>
          ["mismatch", "verified", "build_failed", "source_unavailable", "policy_rejected", "not_attempted"].includes(
            status
          )
        );
        expect(terminalIndex).toBe(run.statusSequence.length - 1);

        // Only one rebuilt hash is ever reported — two attempts producing two different hashes would surface
        // here.
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
