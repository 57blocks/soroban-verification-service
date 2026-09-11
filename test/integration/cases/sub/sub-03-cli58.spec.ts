import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, metadataSubmissionFor, missingFixture } from "../../support/fixtures.js";
import { expectStatus } from "../../support/http.js";
import { preflight, submit, waitForTerminal } from "../../support/job.js";
import { readReportByUrl } from "../../support/result-tree.js";

caseBlock(
  {
    id: "E2E-SUB-03",
    title: "a complete cli-58 chain recipe verifies through the restricted build path",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-58"),
  },
  () => {
    it(
      "uses the chain source_uri and completes through network-isolated rebuild",
      async () => {
        const target = fixtures.contracts["F-58"];
        const inspected = await preflight({
          network: target.network,
          contract_id: target.contract_id,
          wasm_hash: target.wasm_hash,
        });
        expectStatus(inspected, 200);
        expect(inspected.json.build_environment?.kind).toBe("chain_named");
        expect(inspected.json.missing_fields ?? []).toHaveLength(0);

        expect(inspected.json.suggested_manifest?.source_uri).toBe(target.source_uri);
        expect(inspected.json.suggested_manifest?.source_sha256).toBe(target.source_sha256);

        const submitted = await submit(metadataSubmissionFor("F-58"));
        expectStatus(submitted.response, 202);
        expect(submitted.response.json?.message).toBe(
          "Verification job created from on-chain SEP-58 metadata."
        );
        expect(submitted.jobId).toBeDefined();

        // A target-only request must create a metadata job. The other 202 message means this test adopted a
        // concurrently active caller-manifest job, whose provenance cannot answer SUB-03.
        const run = await waitForTerminal(submitted.jobId!);
        expect(run.body.status).toBe("verified");
        expect(run.body.result?.matched).toBe(true);
        expect(run.body.result?.verification_path).toBe("metadata_backed");

        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.provenance.build_isolation).toBe("network_isolated");
        expect(artifact.source?.source_sha256).toBe(target.source_sha256);
      },
      env.jobTimeoutMs + 120_000
    );
  }
);
