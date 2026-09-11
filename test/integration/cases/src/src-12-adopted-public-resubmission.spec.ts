/** E2E-SRC-12 — an adopting job's own `is_public` obligates the source publication its donor skipped */
import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import {
  fixtures,
  missingFixture,
  recipeScopeLabel,
  runScopedBldopt,
  submissionFor,
} from "../../support/fixtures.js";
import { expectStatus, http, sha256Hex } from "../../support/http.js";
import { submitAndWait } from "../../support/job.js";
import {
  ownEntryOf,
  ownVerifierIdentity,
  type OwnVerifierIdentity,
  readReportByUrl,
  readStatusObject,
  requireStatusObject,
} from "../../support/result-tree.js";
import { linkUrls, sourceCodeUriUrls } from "../../support/types.js";

const CASE_ID = "E2E-SRC-12";
const FIXTURE_ID = "F-MULTIPKG";

/** How long the adopting job's source publication may take to appear. */
const SOURCE_PUBLISH_DEADLINE_MS = Number(
  process.env.SCVS_E2E_SOURCE_PUBLISH_DEADLINE_MS ?? 4 * 60_000
);

/** Between polls of `wasms/{H}.json`. Cheap static GET; no reason to hammer it. */
const STATUS_POLL_INTERVAL_MS = Math.min(env.pollIntervalMs, 5_000);

/** Polls this hash's own entry until it carries a `verified_source_code_uris`. */
async function waitForVerifiedSourceCodeUris(
  wasmHash: string,
  identity: OwnVerifierIdentity,
  reportUrl: string
): Promise<string[]> {
  const startedAt = Date.now();
  const deadline = startedAt + SOURCE_PUBLISH_DEADLINE_MS;
  let lastSeen = "(never read)";

  while (Date.now() < deadline) {
    const read = await readStatusObject(wasmHash);
    if (read.found) {
      const entry = ownEntryOf(read.object.source_code_verifications, identity);
      const uris = entry ? sourceCodeUriUrls(entry) : [];
      // `{type, url, sha256}` links — the anchor is the URL inside each entry.
      const results = entry ? linkUrls(entry) : [];
      if (!results.includes(reportUrl)) {
        throw new Error(
          `${CASE_ID}: ${wasmHash}'s entry for ${identity.url} no longer points at ${reportUrl} ` +
            `(results_urls: ${JSON.stringify(results)}). Another verification replaced it, so ` +
            `appendVerifiedSourceCodeUri would correctly decline to attach the source link to a ` +
            `different verdict — this is a fixture-collision problem on this hash, not a failure ` +
            `of the adoption obligation.`
        );
      }
      if (uris.length > 0) return uris;
      lastSeen = `entry present, verified_source_code_uris absent`;
    } else {
      lastSeen = `status object not readable (${read.result.status})`;
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }

  throw new Error(
    `${CASE_ID}: ${wasmHash}'s entry never gained a verified_source_code_uris within ` +
      `${SOURCE_PUBLISH_DEADLINE_MS} ms (last: ${lastSeen}).\n\n` +
      `The adopting job declared is_public: true, so publish.service.ts's ` +
      `completeArchiveObligationsForAdoptedJob should have set source_publish_pending_since on it, ` +
      `and SourcePublishRecoveryScheduler should have run retryPendingSourcePublish within one ` +
      `SCVS_PUBLISH_RECOVERY_INTERVAL_MS. Check, in order: that the obligation was written at all ` +
      `(an adopting job whose visibility was dropped writes none), that the adopting job's staged ` +
      `upload was not deleted before the retry (hasOutstandingObligation must count ` +
      `source_publish_pending_since as owed), and that the retry's fetch succeeded.`
  );
}

caseBlock(
  {
    id: CASE_ID,
    title: "an adopting public resubmission publishes the source its private donor never did",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture(FIXTURE_ID),
  },
  () => {
    it(
      "★ the adopting job's own is_public obligates the source publication its donor skipped",
      async () => {
        // One recipe for both submissions — adoption's precondition.
        const scopedBldopt = runScopedBldopt(
          fixtures.contracts[FIXTURE_ID].bldopt ?? [],
          env.runId,
          recipeScopeLabel(),
          FIXTURE_ID
        );

        const donorBody = await submissionFor(FIXTURE_ID, { bldopt: scopedBldopt });
        const adopterBody = await submissionFor(FIXTURE_ID, {
          bldopt: scopedBldopt,
          is_public: true,
        });
        const donorManifest = donorBody.manifest as unknown as Record<string, unknown>;
        const adopterManifest = adopterBody.manifest as unknown as Record<string, unknown>;

        // ── Premise 1: the two submissions differ in the declaration and nothing else ──────────
        // If they differed in the recipe, the second would build and publish in its own right and this case
        // would prove nothing about adoption.
        expect(adopterManifest.source_sha256).toBe(donorManifest.source_sha256);
        expect(adopterManifest.bldopt).toEqual(donorManifest.bldopt);
        expect(adopterManifest.bldarg).toEqual(donorManifest.bldarg);
        // This is the shape a submitter who simply did not ask sends.
        expect(donorManifest.is_public).toBeUndefined();
        expect(adopterManifest.is_public).toBe(true);
        // Two real submissions, each with its own staging copy. The adopting job's own copy is what the
        // recovery retry reads, which is why it must survive the adoption path's cleanup.
        expect(adopterManifest.upload_id).toBeDefined();
        expect(adopterManifest.upload_id).not.toBe(donorManifest.upload_id);

        // ── 1. The donor: private, verified, published ─────────────────────────────────────────
        const donor = await submitAndWait(donorBody);
        expect(donor.body.status).toBe("verified");
        const wasmHash = donor.body.result?.wasm_hash;
        const donorReportUrl = donor.body.result?.artifact_url;
        expect(wasmHash).toBeDefined();
        expect(donorReportUrl).toBeDefined();

        const donorReport = (await readReportByUrl(donorReportUrl!)).artifact;
        // It declared nothing public, so it stored no copy and named no file.
        expect(donorReport.source?.is_public).toBe(false);
        expect(donorReport.source?.source_file_name).toBeUndefined();
        const sourceSha256 = donorReport.source?.source_sha256;
        expect(sourceSha256).toMatch(/^[0-9a-f]{64}$/);

        // ── Premise 2: non-vacuity — this hash carries no source link yet ──────────────────────
        const identity = await ownVerifierIdentity();
        const before = await requireStatusObject(wasmHash!);
        const beforeEntry = ownEntryOf(before.source_code_verifications, identity);
        expect(beforeEntry?.status).toBe("verified");
        // The anchor `appendVerifiedSourceCodeUri` will look for. Without it the append declines, and the
        // case's central assertion could never pass.
        expect(beforeEntry ? linkUrls(beforeEntry) : []).toContain(donorReportUrl);
        if ((beforeEntry ? sourceCodeUriUrls(beforeEntry) : []).length > 0) {
          throw new Error(
            `${CASE_ID} premise violated: ${wasmHash}'s entry for ${identity.url} already carries ` +
              `verified_source_code_uris ${JSON.stringify(beforeEntry?.verified_source_code_uris)} ` +
              `immediately after a *private* submission published it. Nothing this case does later ` +
              `could then be attributed to the adopting job's own obligation.\n\n` +
              `The recipe is run-scoped precisely so the donor's publish is fresh each run and this ` +
              `entry is rebuilt from scratch (buildWasmStatus carries the field forward only when ` +
              `passed it). A link present here means either the scoping stopped taking effect — so ` +
              `the donor adopted an earlier run's verdict instead of publishing — or a private ` +
              `publish is now emitting the field, which would be a real defect in ` +
              `publish.service.ts's visibility gate.`
          );
        }

        // ── 2. The adopter: same recipe, declared public ───────────────────────────────────────
        const adopter = await submitAndWait(adopterBody);
        expect(adopter.body.status).toBe("verified");
        expect(adopter.jobId).not.toBe(donor.jobId);

        // HA1 — it adopted rather than republished: the donor's artifact, not a second one minted beside it for
        // identical inputs.
        expect(adopter.body.result?.artifact_url).toBe(donorReportUrl);

        // ── 3. HA2 — the adopting job's own visibility obligated the publication ───────────────
        const uris = await waitForVerifiedSourceCodeUris(wasmHash!, identity, donorReportUrl!);
        // Testnet, so S3 is the only eligible tier — Arweave needs `network === "mainnet"`
        // (`isSourceArchiveEligible`).
        expect(uris).toHaveLength(1);
        expect(uris[0]).toContain("/sources/");
        expect(uris[0]).toContain(sourceSha256!);

        // HA3 — and the link resolves to the bytes this verdict was computed from.
        const published = await http(uris[0]);
        expectStatus(published, 200);
        expect(sha256Hex(published.bytes)).toBe(sourceSha256);

        // ── 4. HA4 — the adopted report still records the donor's declaration ─────────────────
        // Asserted so the disagreement is recorded and any future change to it is a deliberate one.
        const adoptedReport = (await readReportByUrl(adopter.body.result!.artifact_url!)).artifact;
        expect(adoptedReport.source?.is_public).toBe(false);
        expect(adoptedReport.source?.source_file_name).toBeUndefined();
        expect(adoptedReport.source?.source_sha256).toBe(sourceSha256);
      },
      // The donor's real build, the adopter's adoption (no build), and the reconciliation tick that publishes
      // the source — plus margin for the two submissions' own polling.
      env.jobTimeoutMs + SOURCE_PUBLISH_DEADLINE_MS + 120_000
    );
  }
);
