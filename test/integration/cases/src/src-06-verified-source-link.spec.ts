/** E2E-SRC-06 — the published link from a `verified` verdict points at the source that produced it */
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

/** The report a status-object entry actually points at. */
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

/** Fetches a retained archive by the file name its own report publishes, and hashes it. */
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
  // The commitment: what came back is what the report said it would be.
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

        // Premise: the two candidates are different archives. Same bytes would make "points at the right one"
        // unanswerable rather than true.
        expect(competitor.source_sha256).not.toBe(hsOk);

        // ── 1. A competing candidate for F-LEG-1's hash ────────────────────────────────────────
        // F-LEG-3's archive is a real, compilable source that builds to different bytes, so this is a
        // `mismatch` and not a build failure.
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

        // ── 2. The matching source ─────────────────────────────────────────────────────────────
        const verified = await submitAndWait(await submissionFor("F-LEG-1", { is_public: true }));
        expect(verified.body.status).toBe("verified");
        const wasmHash = verified.body.result!.wasm_hash!;

        // ── 3. Step 2 of the case, as literally written ────────────────────────────────────────
        const status = await requireStatusObject(wasmHash);
        const ours = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());
        expect(ours?.status).toBe("verified");

        // ── The entry names the source it was verified from (TRD §5.2) ─────────────────────
        // SEP-58 v0.5.0's vocabulary: `source_sha256` required, `source_uri` optional.
        expect(ours!.source_sha256).toBe(hsOk);
        expect(ours!.source_sha256).not.toBe(hsBad);

        const artifact = await reportViaEntry(ours!, wasmHash);
        expect(artifact.result.wasm_hash).toBe(wasmHash);
        expect(artifact.source?.is_public).toBe(true);
        expect(artifact.source?.source_file_name).toBeDefined();

        // HA1 and HA2 — the status object names the same durable source object as its report.
        const declaredUri = staticSourceUrl(artifact.source!.source_file_name!);
        expect(sourceCodeUriUrls(ours!)).toEqual(expect.arrayContaining([declaredUri]));

        const linkedByField = await http(declaredUri);
        expectStatus(linkedByField, 200);
        expect(sha256Hex(linkedByField.bytes)).toBe(hsOk);

        // HA1 — and not to the candidate that failed to reproduce the deployed bytes.
        expect(sha256Hex(linkedByField.bytes)).not.toBe(hsBad);

        // ── 4. HA1 and HA2, through the report path ───────────────────────────────────────────
        const linked = await fetchRetainedSource(artifact, "the verified result");

        // HA2 — equal to the entry's own `source_sha256` commitment.
        expect(linked).toBe(artifact.source!.source_sha256);
        // HA1 — and that commitment is HS_ok, not the candidate that failed to reproduce the bytes.
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
        // If it ever carries a `verified` entry from us the case can never pass again, and that is a
        // fixture-inventory problem with a specific fix rather than something to skip past.
        await assertHashNotYetVerifiedByUs(fixtures.contracts["F-LEG-3"].wasm_hash!, CASE_ID);

        const run = await submitAndWait(await submissionFor("F-LEG-3", { is_public: true }));
        expect(run.body.status).toBe("mismatch");

        const wasmHash = run.body.result!.wasm_hash!;
        const status = await requireStatusObject(wasmHash);
        const ours = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());
        expect(ours?.status).toBe("mismatched");

        // A durable public source remains retrievable even after a mismatch.
        const artifact = await reportViaEntry(ours!, wasmHash);
        const declaredUri = staticSourceUrl(artifact.source!.source_file_name!);
        expect(sourceCodeUriUrls(ours!)).toEqual(expect.arrayContaining([declaredUri]));

        expect(artifact.result.matched).toBe(false);
        expect(ours!.rebuilt_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(ours!.rebuilt_hash).not.toBe(wasmHash);

        // Absence here would be a retention bug, and it would also make HA3 pass for the wrong reason.
        const retained = await fetchRetainedSource(artifact, "the mismatched candidate");
        expect(retained).toBe(fixtures.contracts["F-LEG-3"].source_sha256);
      },
      env.jobTimeoutMs + 120_000
    );
  }
);
