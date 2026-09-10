/** E2E-ARC-03 -- an archived report is byte-for-byte the published report. */
import { linkUrls, type RegistryResultUrl } from "../../support/types.js";
import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectStatus, http, sha256Hex, sleep } from "../../support/http.js";
import { submitAndWait } from "../../support/job.js";
import { ownEntryOf, ownVerifierIdentity, readReportByUrl, requireStatusObject } from "../../support/result-tree.js";

const CASE_ID = "E2E-ARC-03";

/** The archive entry beside `reportUrl`, or undefined while the entry does not carry it yet. */
function archiveUrlFrom(entry: { results_urls?: RegistryResultUrl[] }, reportUrl: string): string | undefined {
  const urls = linkUrls(entry);
  if (!urls.includes(reportUrl)) return undefined;

  const archiveUrls = urls.filter((url) => url !== reportUrl);
  if (archiveUrls.length > 1) {
    throw new Error(
      `${CASE_ID}: expected one archive URL alongside ${reportUrl}, found ${JSON.stringify(archiveUrls)}.`
    );
  }
  return archiveUrls[0];
}

function transactionIdFrom(archiveUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(archiveUrl);
  } catch {
    throw new Error(`${CASE_ID}: archive entry is not an absolute URL: ${JSON.stringify(archiveUrl)}.`);
  }

  const transactionId = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!transactionId) {
    throw new Error(`${CASE_ID}: archive URL has no transaction-id path segment: ${archiveUrl}.`);
  }
  return transactionId;
}

// How long the entry may go without naming this job's report before that is a verdict rather than a wait.
const OWNERSHIP_GRACE_MS = 90_000;

async function waitForArchive(wasmHash: string, reportUrl: string): Promise<string> {
  const started = Date.now();
  const deadline = started + env.jobTimeoutMs;
  const identity = await ownVerifierIdentity();
  let lastUrls: string[] | undefined;
  let sawOwnReport = false;

  while (Date.now() < deadline) {
    const status = await requireStatusObject(wasmHash);
    const entry = ownEntryOf(status.source_code_verifications, identity);
    if (!entry) {
      throw new Error(`${CASE_ID}: ${wasmHash} has no status entry for verifier ${identity.url}.`);
    }

    lastUrls = linkUrls(entry);
    sawOwnReport = sawOwnReport || (lastUrls ?? []).includes(reportUrl);
    const archiveUrl = archiveUrlFrom(entry, reportUrl);
    if (archiveUrl) return archiveUrl;

    if (!sawOwnReport && Date.now() - started > OWNERSHIP_GRACE_MS) {
      throw new Error(
        `${CASE_ID}: the published entry for ${wasmHash} never named this job's report ${reportUrl} ` +
          `within ${OWNERSHIP_GRACE_MS} ms — a later verified job owns the entry, so this case cannot ` +
          `observe the archive of its own report. Last results_urls: ${JSON.stringify(lastUrls)}.`
      );
    }
    await sleep(env.pollIntervalMs);
  }

  throw new Error(
    `${CASE_ID}: ${wasmHash} published ${reportUrl} but no archive URL arrived within ` +
      `${env.jobTimeoutMs} ms. Last results_urls: ${JSON.stringify(lastUrls)}.`
  );
}

caseBlock(
  {
    id: CASE_ID,
    title: "the archive gateway serves exactly the immutable report bytes",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1", "P5"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    let reportUrl: string;
    let archiveUrl: string;
    let reportBytes: Uint8Array;
    let archiveBytes: Uint8Array;
    let reportSha256: string;
    let archiveTransactionId: string;

    beforeAll(async () => {
      const run = await submitAndWait(await submissionFor("F-LEG-1"));
      reportUrl = run.body.result?.artifact_url ?? "";
      if (!reportUrl) throw new Error(`${CASE_ID}: completed job did not expose result.artifact_url.`);

      const wasmHash = run.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-1"].wasm_hash;
      if (!wasmHash) throw new Error(`${CASE_ID}: F-LEG-1 has no Wasm hash.`);

      archiveUrl = await waitForArchive(wasmHash, reportUrl);
      archiveTransactionId = transactionIdFrom(archiveUrl);

      const report = await readReportByUrl(reportUrl);
      const archive = await http(archiveUrl, { bare: true });
      expectStatus(archive, 200);

      reportBytes = report.bytes;
      archiveBytes = archive.bytes;
      reportSha256 = report.sha256;
    }, 2 * env.jobTimeoutMs + 120_000);

    it("/byte_identity -- the published report and direct archive download are identical", () => {
      expect(archiveBytes).toEqual(reportBytes);
    });

    it("/sha256_identity -- both locations hash to the report's content-addressed key", () => {
      const reportKey = reportUrl.match(/\/reports\/([0-9a-f]{64})\.json(?:[?#].*)?$/i)?.[1]?.toLowerCase();
      expect(reportKey).toBeDefined();
      expect(reportSha256).toBe(reportKey);
      expect(sha256Hex(archiveBytes)).toBe(reportSha256);
    });

    it("/transaction_not_embedded -- archive backfill did not rewrite the immutable report", () => {
      const reportText = new TextDecoder().decode(reportBytes);
      expect(reportText).not.toContain(archiveTransactionId);
    });
  }
);
