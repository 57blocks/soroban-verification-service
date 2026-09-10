/** E2E-SUB-12 — comparison uses the contract's freshly fetched deployment hash. */
import { fixture, missingFixture } from "../../support/fixtures.js";
import { caseBlock } from "../../support/gate.js";
import { preflight, readJob } from "../../support/job.js";
import {
  ownEntryOf,
  ownVerifierIdentity,
  readReportByUrl,
  readStatusObject,
  requireStatusObject,
} from "../../support/result-tree.js";
import { readSub12Evidence } from "../../support/sub-infra-evidence.js";
import { linkUrls } from "../../support/types.js";

caseBlock(
  {
    id: "E2E-SUB-12",
    title: "an address upgraded while queued is compared and published under the fresh hash",
    mode: "AUTO-INFRA",
    needs: [
      "SCVS_E2E_VERIFY_URL",
      "SCVS_E2E_RESULT_ROOT",
      "SCVS_E2E_SUB12_EVIDENCE_PATH",
    ],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-UPG"),
  },
  () => {
    it("binds old/new chain state to one job and publishes only the fresh comparison target", async () => {
      const target = fixture("F-UPG");
      const evidence = readSub12Evidence();
      expect(evidence.contractId).toBe(target.contract_id);
      expect(evidence.oldHash).toBe(target.wasm_hash);
      expect(evidence.newHash).toBe(target.prepared_new_wasm_hash);

      const job = await readJob(evidence.jobId);
      expect(job.target.contract_id).toBe(evidence.contractId);
      expect(Date.parse(job.created_at)).toBeLessThanOrEqual(evidence.upgradedAtMs);
      expect(Date.parse(job.updated_at)).toBeGreaterThanOrEqual(evidence.dispatchResumedAtMs);
      expect(Date.parse(job.updated_at)).toBeLessThanOrEqual(evidence.restoredAtMs);

      // The old source is deliberately rebuilt after the address moves to new bytes.
      expect(job.status).toBe("mismatch");
      expect(job.result?.wasm_hash).toBe(evidence.newHash);
      expect(job.result?.expected_wasm_hash).toBe(evidence.newHash);
      expect(job.result?.rebuilt_wasm_hash).toBe(evidence.oldHash);
      expect(job.result?.matched).toBe(false);
      expect(job.result?.contract_binding_drifted).toBe(true);
      expect(job.result?.artifact_url).toEqual(expect.any(String));

      const report = await readReportByUrl(job.result!.artifact_url!);
      expect(report.artifact.result.wasm_hash).toBe(evidence.newHash);
      expect(report.artifact.result.rebuilt_wasm_hash).toBe(evidence.oldHash);
      expect(report.artifact.result.contract_binding_drifted).toBe(true);

      const identity = await ownVerifierIdentity();
      const fresh = await requireStatusObject(evidence.newHash);
      const freshEntry = ownEntryOf(fresh.source_code_verifications, identity);
      expect(freshEntry?.status).toBe("mismatched");
      expect(freshEntry?.rebuilt_hash).toBe(evidence.oldHash);
      // `results_urls` carries `{type, url, sha256}` links; read the URL out of each.
      expect(linkUrls(freshEntry ?? {})).toContain(job.result!.artifact_url!);

      const old = await readStatusObject(evidence.oldHash);
      if (old.found) {
        const oldEntry = ownEntryOf(old.object.source_code_verifications, identity);
        expect(linkUrls(oldEntry ?? {})).not.toContain(job.result!.artifact_url!);
      }

      // The ledger remains on H_new after the case. Preflight is a second, public read proving the report did
      // not merely trust Operations evidence for the address binding.
      const current = await preflight({ network: target.network, contract_id: evidence.contractId });
      expect(current.status).toBe(200);
      expect(current.json?.wasm_hash).toBe(evidence.newHash);
    });
  }
);
