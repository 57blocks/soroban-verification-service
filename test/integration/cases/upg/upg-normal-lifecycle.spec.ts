/** E2E-UPG-01 — a normal contract upgrade verifies both versions at one address. */
import { env } from "../../support/env.js";
import { fixture, missingFixture, submissionFor } from "../../support/fixtures.js";
import { caseBlock } from "../../support/gate.js";
import { expectStatus, http } from "../../support/http.js";
import { preflight, submitAndWait } from "../../support/job.js";
import {
  ownEntryOf,
  ownVerifierIdentity,
  readReportByUrl,
  requireStatusObject,
} from "../../support/result-tree.js";
import { aggregatedByAddressUrl } from "../../support/routes.js";
import { linkUrls, type AggregatedWasmStatus } from "../../support/types.js";
import { upgradeFixtureToV2 } from "../../support/upgrade-control.js";

function assertVerifiedVersion(
  run: Awaited<ReturnType<typeof submitAndWait>>,
  expectedHash: string,
  expectedSourceHash: string
) {
  expect(run.body.status).toBe("verified");
  expect(run.body.result?.wasm_hash).toBe(expectedHash);
  expect(run.body.result?.expected_wasm_hash).toBe(expectedHash);
  expect(run.body.result?.rebuilt_wasm_hash).toBe(expectedHash);
  expect(run.body.result?.matched).toBe(true);
  expect(run.body.result?.contract_binding_drifted).toBeUndefined();
  expect(run.body.result?.artifact_url).toEqual(expect.any(String));
  expect(expectedSourceHash).toMatch(/^[a-f0-9]{64}$/);
}

caseBlock(
  {
    id: "E2E-UPG-01/normal_upgrade_lifecycle",
    title: "a run-scoped contract verifies v1, upgrades, then verifies v2 at the same address",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_QUERY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-UPG-V1", "F-UPG-V2"),
  },
  () => {
    it(
      "keeps both hash-keyed results and resolves the address immediately to verified v2",
      async () => {
        const v1 = fixture("F-UPG-V1");
        const v2 = fixture("F-UPG-V2");
        const contractId = v1.contract_id!;
        const oldHash = v1.wasm_hash!;
        const newHash = v2.wasm_hash!;

        expect(contractId).toBe(v2.contract_id);
        expect(oldHash).not.toBe(newHash);

        const before = await preflight({ network: v1.network, contract_id: contractId });
        expectStatus(before, 200);
        expect(before.json?.wasm_hash).toBe(oldHash);

        const v1Run = await submitAndWait(await submissionFor("F-UPG-V1"));
        assertVerifiedVersion(v1Run, oldHash, v1.source_sha256!);
        expect(v1Run.body.target.contract_id).toBe(contractId);
        const v1Report = await readReportByUrl(v1Run.body.result!.artifact_url!);
        expect(v1Report.artifact.result.rebuilt_wasm_hash).toBe(oldHash);
        expect(v1Report.artifact.source?.source_sha256).toBe(v1.source_sha256);

        const oldAddress = await http(aggregatedByAddressUrl(v1.network, contractId));
        expectStatus(oldAddress, 200);
        expect((oldAddress.json as AggregatedWasmStatus).wasm_hash).toBe(oldHash);

        upgradeFixtureToV2();

        const after = await preflight({ network: v2.network, contract_id: contractId });
        expectStatus(after, 200);
        expect(after.json?.wasm_hash).toBe(newHash);

        const v2Run = await submitAndWait(await submissionFor("F-UPG-V2"));
        expect(v2Run.jobId).not.toBe(v1Run.jobId);
        assertVerifiedVersion(v2Run, newHash, v2.source_sha256!);
        expect(v2Run.body.target.contract_id).toBe(contractId);
        const v2Report = await readReportByUrl(v2Run.body.result!.artifact_url!);
        expect(v2Report.artifact.result.rebuilt_wasm_hash).toBe(newHash);
        expect(v2Report.artifact.source?.source_sha256).toBe(v2.source_sha256);

        const immediate = await http(aggregatedByAddressUrl(v2.network, contractId));
        expectStatus(immediate, 200);
        expect((immediate.json as AggregatedWasmStatus).wasm_hash).toBe(newHash);

        const repeated = await http(aggregatedByAddressUrl(v2.network, contractId));
        expectStatus(repeated, 200);
        expect((repeated.json as AggregatedWasmStatus).wasm_hash).toBe(newHash);

        const identity = await ownVerifierIdentity();
        const oldStatus = await requireStatusObject(oldHash);
        const newStatus = await requireStatusObject(newHash);
        expect(ownEntryOf(oldStatus.source_code_verifications, identity)?.status).toBe("verified");
        expect(ownEntryOf(newStatus.source_code_verifications, identity)?.status).toBe("verified");
        // A `results_urls` entry is `{type, url, sha256}` (AU1), so the pointer has to
        // be read out of each link. Comparing the array itself to a URL string was not merely wrong
        // here — the negative half passed vacuously, because no object can ever equal a URL.
        const oldEntryLinks = linkUrls(ownEntryOf(oldStatus.source_code_verifications, identity) ?? {});
        expect(oldEntryLinks).toContain(v1Run.body.result!.artifact_url!);
        expect(oldEntryLinks).not.toContain(v2Run.body.result!.artifact_url!);

        const addressKeyed = await http(`${env.resultRoot}/contracts/${contractId}.json`);
        expect([403, 404]).toContain(addressKeyed.status);
      },
      env.jobTimeoutMs * 2 + 180_000
    );
  }
);
