import { linkUrls, sourceCodeUriUrls } from "../../support/types.js";
import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectStatus, http, sha256Hex } from "../../support/http.js";
import { submitAndWait } from "../../support/job.js";
import { staticSourceUrl } from "../../support/routes.js";
import {
  assertHashNotYetVerifiedByUs,
  ownEntryOf,
  ownVerifierIdentity,
  readReportByUrl,
  requireStatusObject,
} from "../../support/result-tree.js";
import type { RegistryVerification, VerificationArtifact } from "../../support/types.js";

const CASE_ID = "E2E-SRC-06";

async function reportViaEntry(
  entry: RegistryVerification,
  wasmHash: string
): Promise<VerificationArtifact> {
  const pointer = linkUrls(entry).find((url) => url.includes("/reports/"));
  if (!pointer) {
    throw new Error(
      `${CASE_ID}: the published entry for ${wasmHash} carries no report pointer in results_urls ` +
        `(${JSON.stringify(entry.results_urls)}). A consumer therefore has no route from this verdict ` +
        `to its source, which is the property §6.3 exists to guarantee.`
    );
  }
  return (await readReportByUrl(pointer)).artifact;
}

async function fetchRetainedSource(artifact: VerificationArtifact, label: string): Promise<string> {
  const source = artifact.source;
  if (!source?.source_file_name) {
    throw new Error(
      `${CASE_ID}: ${label} was submitted with is_public: true but its report publishes no ` +
        `source.source_file_name, so the retained archive is unaddressable. The extension is not ` +
        `fixed (packages/storage-layout/src/keys.ts), which is why the file name — not the hash — is ` +
        `what a consumer needs.`
    );
  }
  const fetched = await http(staticSourceUrl(source.source_file_name));
  expectStatus(fetched, 200);
  const hash = sha256Hex(fetched.bytes);
  expect(hash).toBe(source.source_sha256);
  return hash;
}

caseBlock(
  {
    id: CASE_ID,
    title: "the verified verdict links to the matching source, not to a competing candidate",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1", "F-LEG-3"),
  },
  () => {
    it(
      "★ resolves to HS_ok, with a real HS_bad retained for the same hash",
      async () => {
        const target = fixtures.contracts["F-LEG-1"];
        const competitor = fixtures.contracts["F-LEG-3"];
        const hsOk = target.source_sha256!;

        expect(competitor.source_sha256).not.toBe(hsOk);

        const competingBody = await submissionFor("F-LEG-3", { is_public: true });
        const competing = await submitAndWait({
          ...competingBody,
          target: { network: target.network, contract_id: target.contract_id! },
        });
        expect(competing.body.status).toBe("mismatch");

        const competingReport = (await readReportByUrl(competing.body.result!.artifact_url!)).artifact;
        const hsBad = await fetchRetainedSource(competingReport, "the competing candidate");
        expect(hsBad).toBe(competitor.source_sha256);
        expect(hsBad).not.toBe(hsOk);

        const verified = await submitAndWait(await submissionFor("F-LEG-1", { is_public: true }));
        expect(verified.body.status).toBe("verified");
        const wasmHash = verified.body.result!.wasm_hash!;

        const status = await requireStatusObject(wasmHash);
        const ours = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());
        expect(ours?.status).toBe("verified");

        expect(ours!.source_sha256).toBe(hsOk);
        expect(ours!.source_sha256).not.toBe(hsBad);

        const artifact = await reportViaEntry(ours!, wasmHash);
        expect(artifact.result.wasm_hash).toBe(wasmHash);
        expect(artifact.source?.is_public).toBe(true);
        expect(artifact.source?.source_file_name).toBeDefined();

        const declaredUri = staticSourceUrl(artifact.source!.source_file_name!);
        expect(sourceCodeUriUrls(ours!)).toEqual(expect.arrayContaining([declaredUri]));

        const linkedByField = await http(declaredUri);
        expectStatus(linkedByField, 200);
        expect(sha256Hex(linkedByField.bytes)).toBe(hsOk);

        expect(sha256Hex(linkedByField.bytes)).not.toBe(hsBad);

        const linked = await fetchRetainedSource(artifact, "the verified result");

        expect(linked).toBe(artifact.source!.source_sha256);
        expect(linked).toBe(hsOk);
        expect(linked).not.toBe(hsBad);

        const stillThere = await http(
          staticSourceUrl(competingReport.source!.source_file_name!)
        );
        expectStatus(stillThere, 200);
      },
      2 * env.jobTimeoutMs + 120_000
    );

    it(
      "HA3 — a `mismatched` entry identifies the attempted public source without claiming a match",
      async () => {
        await assertHashNotYetVerifiedByUs(fixtures.contracts["F-LEG-3"].wasm_hash!, CASE_ID);

        const run = await submitAndWait(await submissionFor("F-LEG-3", { is_public: true }));
        expect(run.body.status).toBe("mismatch");

        const wasmHash = run.body.result!.wasm_hash!;
        const status = await requireStatusObject(wasmHash);
        const ours = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());
        expect(ours?.status).toBe("mismatched");

        const artifact = await reportViaEntry(ours!, wasmHash);
        const declaredUri = staticSourceUrl(artifact.source!.source_file_name!);
        expect(sourceCodeUriUrls(ours!)).toEqual(expect.arrayContaining([declaredUri]));

        expect(artifact.result.matched).toBe(false);
        expect(ours!.rebuilt_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(ours!.rebuilt_hash).not.toBe(wasmHash);

        const retained = await fetchRetainedSource(artifact, "the mismatched candidate");
        expect(retained).toBe(fixtures.contracts["F-LEG-3"].source_sha256);
      },
      env.jobTimeoutMs + 120_000
    );
  }
);
