/**
 * E2E-PUB-05 — immutable, content-addressed report artifacts E2E-PUB-06 — reports retain verification-time
 * facts after source loss
 */
import { caseBlock } from "../../support/gate.js";
import { darkSourceControl, env } from "../../support/env.js";
import { fixtures, missingDeployedTarget, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectStatus, http, sha256Hex } from "../../support/http.js";
import { submitAndWait } from "../../support/job.js";
import { staticSourceUrl } from "../../support/routes.js";
import { setDarkSourceAvailable, waitForSourceUri } from "../../support/source-control.js";
import { ownEntryOf, ownVerifierIdentity, readReportByUrl, requireStatusObject } from "../../support/result-tree.js";
import { linkUrl, type RegistryResultUrl } from "../../support/types.js";

/** `reports/<report_sha256>.json` — the anchor a pre-cutover consumer reads, beside the link's own `sha256`. */
const REPORT_POINTER = /\/reports\/([0-9a-f]{64})\.json(?:[?#].*)?$/i;

/** The `results_urls` link pointing at this report, in either the SEP or the pre-cutover form. */
function reportLink(entry: unknown, reportUrl: string): RegistryResultUrl | undefined {
  const links = (entry as { results_urls?: RegistryResultUrl[] }).results_urls ?? [];
  return links.find((link) => linkUrl(link) === reportUrl);
}

function darkSourcePrerequisite(): string | undefined {
  const missing = missingDeployedTarget("F-DARK");
  if (missing) return missing;
  if (darkSourceControl.kind === "absent") return `📐 ${darkSourceControl.describe}`;

  const sourceUri = fixtures.contracts["F-DARK"].source_uri;
  if (!sourceUri) return "F-DARK carries no source_uri";
  try {
    const { hostname } = new URL(sourceUri);
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(hostname)) {
      return `F-DARK source_uri ${sourceUri} is only reachable from the test runner, not the deployment`;
    }
  } catch {
    return `F-DARK source_uri is not an absolute URL: ${JSON.stringify(sourceUri)}`;
  }

  const darkHash = fixtures.contracts["F-DARK"].source_sha256;
  const duplicate = Object.values(fixtures.contracts).find(
    (fixture) => fixture.id !== "F-DARK" && fixture.source_sha256 === darkHash
  );
  return duplicate
    ? `F-DARK shares source_sha256 with ${duplicate.id}; source retention after origin loss is ambiguous`
    : undefined;
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

caseBlock(
  {
    id: "E2E-PUB-06",
    title: "report records verification-time facts, not later source availability",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: darkSourcePrerequisite,
  },
  () => {
    const dark = fixtures.contracts["F-DARK"];
    let reportUrl: string;
    let reportBytes: Uint8Array;
    let reportSha256: string;
    let wasmHash: string;

    beforeAll(async () => {
      await setDarkSourceAvailable(true, "E2E-PUB-06");
      await waitForSourceUri(dark.source_uri!, "reachable");

      const run = await submitAndWait(await submissionFor("F-DARK", { is_public: true }));
      expect(["verified", "mismatch"]).toContain(run.body.status);
      wasmHash = run.body.result?.wasm_hash ?? dark.wasm_hash ?? "";
      if (!wasmHash) throw new Error("E2E-PUB-06: F-DARK has no Wasm hash");
      reportUrl = run.body.result?.artifact_url ?? "";
      if (!reportUrl) throw new Error("E2E-PUB-06: completed job did not expose result.artifact_url");

      const report = await readReportByUrl(reportUrl);
      reportBytes = report.bytes;
      reportSha256 = report.sha256;
      expect(report.artifact.source?.is_public).toBe(true);
      expect(report.artifact.source?.source_sha256).toBe(dark.source_sha256);
      expect(report.artifact.source?.source_file_name).toBeDefined();

      const retained = await http(staticSourceUrl(report.artifact.source!.source_file_name!));
      expectStatus(retained, 200);
      expect(sha256Hex(retained.bytes)).toBe(dark.source_sha256);

      await setDarkSourceAvailable(false, "E2E-PUB-06");
      await waitForSourceUri(dark.source_uri!, "gone");
    }, 2 * env.jobTimeoutMs + 180_000);

    afterAll(async () => {
      if (darkSourceControl.kind === "endpoint") {
        await setDarkSourceAvailable(true, "E2E-PUB-06").catch(() => undefined);
      }
    });

    it("/source_uri_goes_dark — the report remains byte-identical after its origin is unavailable", async () => {
      const origin = await http(dark.source_uri!, { bare: true });
      expect([404, 410]).toContain(origin.status);

      const again = await readReportByUrl(reportUrl);
      expect(again.sha256).toBe(reportSha256);
      expect(again.bytes).toEqual(reportBytes);
      expect(again.artifact.source?.source_sha256).toBe(dark.source_sha256);
      expect(again.artifact.source?.is_public).toBe(true);

      // `source_uri` is a verification-time observation.
      const status = await requireStatusObject(wasmHash);
      const entry = ownEntryOf(status.source_code_verifications, await ownVerifierIdentity());
      expect(entry).toBeDefined();
      expect(entry!.source_uri).toBe(dark.source_uri);
      expect(entry!.source_sha256).toBe(dark.source_sha256);
    });
  }
);
