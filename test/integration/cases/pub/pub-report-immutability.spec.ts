/** E2E-PUB-05 — immutable, content-addressed report artifacts. */
import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectStatus, http, sha256Hex } from "../../support/http.js";
import { submitAndWait } from "../../support/job.js";
import { ownEntryOf, ownVerifierIdentity, readReportByUrl, requireStatusObject } from "../../support/result-tree.js";
import { linkUrl, type RegistryResultUrl } from "../../support/types.js";

/** `reports/<report_sha256>.json` — the anchor a pre-cutover consumer reads, beside the link's own `sha256`. */
const REPORT_POINTER = /\/reports\/([0-9a-f]{64})\.json(?:[?#].*)?$/i;

/** The `results_urls` link pointing at this report, in either the SEP or the pre-cutover form. */
function reportLink(entry: unknown, reportUrl: string): RegistryResultUrl | undefined {
  const links = (entry as { results_urls?: RegistryResultUrl[] }).results_urls ?? [];
  return links.find((link) => linkUrl(link) === reportUrl);
}

caseBlock(
  {
    id: "E2E-PUB-05",
    title: "report artifacts are content-addressed and immutable",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    let reportUrl: string;
    let reportBytes: Uint8Array;
    let reportSha256: string;
    let statusEntry: unknown;

    beforeAll(async () => {
      const run = await submitAndWait(await submissionFor("F-LEG-1"));
      reportUrl = run.body.result?.artifact_url ?? "";
      if (!reportUrl) throw new Error("E2E-PUB-05: completed job did not expose result.artifact_url");

      const report = await readReportByUrl(reportUrl);
      reportBytes = report.bytes;
      reportSha256 = report.sha256;
      expect(run.body.result?.artifact_sha256).toBe(reportSha256);

      const wasmHash = run.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-1"].wasm_hash;
      if (!wasmHash) throw new Error("E2E-PUB-05: F-LEG-1 has no Wasm hash");
      const status = await requireStatusObject(wasmHash);
      statusEntry = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());
      expect(statusEntry).toBeDefined();
    }, env.jobTimeoutMs + 120_000);

    it("/bytes_stable — repeated reads of the immutable report return identical bytes", async () => {
      const again = await readReportByUrl(reportUrl);
      expect(again.sha256).toBe(reportSha256);
      expect(again.bytes).toEqual(reportBytes);
    });

    it("/hash_matches_results_urls — the published report pointer carries the exact content hash", () => {
      // Two anchors (AU1 reinstated): the entry states its own `sha256`, and the
      // content-addressed filename states it again. Both must equal the bytes retrieved.
      const link = reportLink(statusEntry, reportUrl);
      expect(link).toBeDefined();
      expect(reportUrl.match(REPORT_POINTER)?.[1]?.toLowerCase()).toBe(reportSha256);
      if (typeof link === "object") {
        expect(link.type).toBe("report");
        expect(link.sha256).toBe(reportSha256);
      }
    });

    it("/no_self_hash — report bytes do not embed the hash that addresses them", () => {
      const text = new TextDecoder().decode(reportBytes);
      expect(sha256Hex(reportBytes)).toBe(reportSha256);
      expect(text).not.toContain(reportSha256);
    });
  }
);
