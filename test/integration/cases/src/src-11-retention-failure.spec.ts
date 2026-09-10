/** E2E-SRC-11 — a source-retention write failure blocks nothing, and claims nothing false */
import { caseBlock } from "../../support/gate.js";
import { env, objectStoreFaultInjector } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectStatus, http, sha256Hex, sleep } from "../../support/http.js";
import { submitAndWait, type TerminalJob } from "../../support/job.js";
import { staticSourceUrl, staticWasmStatusUrl } from "../../support/routes.js";
import { SOURCE_PREFIX, setSourceRetentionFault } from "../../support/source-control.js";
import { readReportByUrl, readStatusObject } from "../../support/result-tree.js";
import type { VerificationArtifact } from "../../support/types.js";

const CASE_ID = "E2E-SRC-11";

/** How far above the measured baseline the faulted run's **publication** latency may sit. */
const PUBLICATION_LATENCY_ALLOWANCE_MS = 60_000;

/** How long `wasms/{H}.json` is given to become readable after the job reports terminal. */
const PUBLICATION_DEADLINE_MS = 120_000;

/** Terminal verdict → status object readable. Returns the elapsed milliseconds. */
async function publicationLatencyMs(run: TerminalJob & { jobId: string }): Promise<number> {
  const wasmHash = run.body.result?.wasm_hash;
  if (!wasmHash) {
    throw new Error(
      `${CASE_ID}: job ${run.jobId} reached ${run.body.status} with no result.wasm_hash, so there is ` +
        `no status object to wait for.`
    );
  }

  const started = Date.now();
  const deadline = started + PUBLICATION_DEADLINE_MS;
  while (Date.now() < deadline) {
    const read = await readStatusObject(wasmHash);
    if (read.found) return Date.now() - started;
    await sleep(2_000);
  }

  throw new Error(
    `${CASE_ID}: ${staticWasmStatusUrl(wasmHash)} did not become readable within ` +
      `${PUBLICATION_DEADLINE_MS} ms of a terminal ${run.body.status}. Hard assertion 1 is that ` +
      `retention cannot block publication; this is that assertion failing.`
  );
}

/** Every URL the published record claims points at stored source. HA3 operates on exactly this set. */
function claimedSourceUrls(artifact: VerificationArtifact): string[] {
  const fileName = artifact.source?.source_file_name;
  return fileName ? [staticSourceUrl(fileName)] : [];
}

caseBlock(
  {
    id: `${CASE_ID}/negative_control`,
    title: "🔁 with healthy retention the same flow does store the source",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-SRC11-CONTROL"),
  },
  () => {
    it(
      "stores and serves HS′, so the fault run cannot pass on a deployment that never retains",
      async () => {
        // The control's whole job. Without it, a deployment whose retention is broken for unrelated reasons
        // passes the fault case perfectly: the object is missing, as predicted, for the wrong reason.
        const control = fixtures.contracts["F-SRC11-CONTROL"];
        const run = await submitAndWait(await submissionFor("F-SRC11-CONTROL", { is_public: true }));
        expect(["verified", "mismatch"]).toContain(run.body.status);

        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.source?.is_public).toBe(true);
        expect(artifact.source?.source_sha256).toBe(control.source_sha256);
        expect(artifact.source?.source_file_name).toBeDefined();

        const copy = await http(staticSourceUrl(artifact.source!.source_file_name!));
        expectStatus(copy, 200);
        expect(sha256Hex(copy.bytes)).toBe(control.source_sha256);

        process.stdout.write(
          `[${CASE_ID}/negative_control] publication latency ` +
            `${await publicationLatencyMs(run)} ms (baseline)\n`
        );
      },
      env.jobTimeoutMs + 180_000
    );
  }
);

caseBlock(
  {
    id: CASE_ID,
    title: "a failed retention write does not block publication and claims no stored copy",
    // AUTO-INFRA: the run deliberately breaks a slice of the deployment's object storage.
    mode: "AUTO-INFRA",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1", "P12"],
    unless: () => {
      const missing = missingFixture("F-SRC11-FAULT", "F-SRC11-CONTROL");
      if (missing) return missing;
      if (objectStoreFaultInjector.kind === "absent") return `📐 ${objectStoreFaultInjector.describe}`;
      return undefined;
    },
  },
  () => {
    const fault = fixtures.contracts["F-SRC11-FAULT"];

    afterAll(async () => {
      // Cleanup step 1, unconditionally.
      await setSourceRetentionFault("healthy", CASE_ID).catch(() => undefined);
    });

    it(
      "★ publishes normally, does not call it private, and links to nothing that is not there",
      async () => {
        // ── Baseline, measured with retention healthy ──────────────────────────────────────────
        // Measured here rather than borrowed from the negative-control block: `caseBlock` can skip that block
        // independently, and a baseline carried between describes is the coupling that produced the bug
        // `cases/sec/sec-planted-artifact.spec.ts` records.
        await setSourceRetentionFault("healthy", CASE_ID);
        const baselineRun = await submitAndWait(
          await submissionFor("F-SRC11-CONTROL", { is_public: true })
        );
        const baselineMs = await publicationLatencyMs(baselineRun);

        // ── Step 1: fail writes under `sources/`, and nothing else ─────────────────────────────
        await setSourceRetentionFault("fail_writes", CASE_ID);

        // ── Step 2 ────────────────────────────────────────────────────────────────────────────
        const run = await submitAndWait(await submissionFor("F-SRC11-FAULT", { is_public: true }));

        // HA1, first half: the verdict exists and is a real one.
        expect(["verified", "mismatch"]).toContain(run.body.status);
        expect(run.body.result?.reason).not.toBe("internal_error");

        // ── Step 3: HA1, second half ──────────────────────────────────────────────────────────
        const faultedMs = await publicationLatencyMs(run);
        process.stdout.write(
          `[${CASE_ID}] publication latency: baseline ${baselineMs} ms, faulted ${faultedMs} ms ` +
            `(allowance ${PUBLICATION_LATENCY_ALLOWANCE_MS} ms — see the constant's comment)\n`
        );
        expect(faultedMs).toBeLessThanOrEqual(baselineMs + PUBLICATION_LATENCY_ALLOWANCE_MS);

        // ── Step 4 ────────────────────────────────────────────────────────────────────────────
        const wasmHash = run.body.result!.wasm_hash!;
        const status = await readStatusObject(wasmHash);
        expect(status.found).toBe(true);

        const { artifact } = await readReportByUrl(run.body.result!.artifact_url!);
        expect(artifact.source?.source_sha256).toBe(fault.source_sha256);

        // HA2, on the field that exists.
        expect(artifact.source?.is_public).toBe(true);

        // HA2 as literally written. `trust.source_visibility` is absent from every published shape, and README
        // gap 9 records that the vocabulary has no value for this state anyway.

        // ── Steps 5-6: HA3 ────────────────────────────────────────────────────────────────────
        // "Either the response does not claim a stored copy, or every claimed URL returns 200.
        const claimed = claimedSourceUrls(artifact);
        for (const url of claimed) {
          const response = await http(url);
          expect({ url, status: response.status }).toEqual({ url, status: 200 });
        }
        if (claimed.length === 0) {
          process.stdout.write(
            `[${CASE_ID}] the record claims no stored copy — HA3's first branch; the write failed ` +
              `and the report did not pretend otherwise\n`
          );
        }

        // ── Step 7: diagnostic A ──────────────────────────────────────────────────────────────
        // Reported so the run still says what it saw.
        process.stdout.write(
          `[${CASE_ID}] diagnostic A — no public surface enumerates "published but not retained"; ` +
            `${SOURCE_PREFIX} write failures are observable only in deployment logs/metrics\n`
        );

        // ── Step 8: diagnostic B, then cleanup step 2 ─────────────────────────────────────────
        await setSourceRetentionFault("healthy", CASE_ID);
        await sleep(5_000);
        const afterRecovery = artifact.source?.source_file_name
          ? await http(staticSourceUrl(artifact.source.source_file_name))
          : undefined;
        process.stdout.write(
          `[${CASE_ID}] diagnostic B — automatic backfill after healing: ` +
            `${afterRecovery ? afterRecovery.status : "no claimed URL to re-read"} ` +
            `(not asserted; there is no persistent retention work item — README gap 10)\n`
        );

        // Cleanup step 2: backfill by re-running the same source under a fresh run-scoped recipe, so no record
        // is left declaring `is_public: true` with nothing stored.
        const backfill = await submitAndWait(await submissionFor("F-SRC11-FAULT", { is_public: true }));
        const backfilled = await readReportByUrl(backfill.body.result!.artifact_url!);
        const backfilledName = backfilled.artifact.source?.source_file_name;
        if (backfilledName) {
          const stored = await http(staticSourceUrl(backfilledName));
          expect(stored.status).toBe(200);
          expect(sha256Hex(stored.bytes)).toBe(fault.source_sha256);
        } else {
          throw new Error(
            `${CASE_ID} cleanup: the backfill run published no source_file_name, so ${fault.source_sha256} ` +
              `is still unretained while its record declares is_public. That is README gap 9's state ` +
              `until an operator stores the archive.`
          );
        }
      },
      3 * env.jobTimeoutMs + 300_000
    );
  }
);
