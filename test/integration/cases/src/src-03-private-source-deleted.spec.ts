/** E2E-SRC-03 — non-public source is deleted when the job terminates, on every terminal path */
import { caseBlock, rowTest } from "../../support/gate.js";
import {
  env,
  internalErrorTargetContractId,
  stagingDeletionDeadlineMs,
  stagingObserver,
} from "../../support/env.js";
import { missingFixture, submissionFor, uploadFixtureArchive } from "../../support/fixtures.js";
import { http } from "../../support/http.js";
import { submit, submitAndWait } from "../../support/job.js";
import { staticSourceUrl } from "../../support/routes.js";
import { readReportByUrl, readStatusObject } from "../../support/result-tree.js";
import {
  expectObservable,
  observeStagedUpload,
  waitForStagedUploadAbsence,
} from "../../support/staging.js";

/** A deadline must leave the expiry sweep no chance to be the cause. */
const MAX_DEADLINE_FRACTION_OF_TTL = 0.5;

interface Row {
  readonly suffix: string;
  readonly fixtureId: string;
  /** The job status this row polls to — the job vocabulary, so `mismatch` and not `mismatched`. */
  readonly terminalStatus: string;
  /** Overrides only the target; the source remains the row's private fixture. */
  readonly target?: { readonly contract_id: string };
  /** `JobStatusBody.error`, asserted when the terminal path has a stable public reason code. */
  readonly expectedError?: string;
  readonly unavailable?: string;
}

const rows: Row[] = [
  {
    suffix: "on_verified",
    fixtureId: "F-PRIV",
    terminalStatus: "verified",
    unavailable: missingFixture("F-PRIV"),
  },
  {
    suffix: "on_mismatched",
    fixtureId: "F-PRIV-MISMATCH",
    terminalStatus: "mismatch",
    unavailable: missingFixture("F-PRIV-MISMATCH"),
  },
  {
    suffix: "on_build_failed",
    fixtureId: "F-PRIV-BUILDFAILED",
    terminalStatus: "build_failed",
    unavailable: missingFixture("F-PRIV-BUILDFAILED"),
  },
  {
    suffix: "on_internal_error",
    fixtureId: "F-PRIV",
    terminalStatus: "build_failed",
    ...(internalErrorTargetContractId
      ? {
          target: { contract_id: internalErrorTargetContractId },
          expectedError: "stellar_contract_fetch_failed",
        }
      : {
          unavailable:
            "missing SCVS_E2E_INTERNAL_ERROR_CONTRACT_ID: provide a controlled, structurally valid " +
            "contract id that is absent from the target network for this maintenance window. The " +
            "real chain lookup then records internal_error/stellar_contract_fetch_failed; no owned " +
            "component is stubbed.",
        }),
  },
];

caseBlock(
  {
    id: "E2E-SRC-03",
    title: "non-public source is deleted when the job terminates",
    // AUTO-INFRA: the run needs a privileged staging observer and, for direct S3, an isolated bucket with
    // short-lived credentials.
    mode: "AUTO-INFRA",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => {
      if (stagingObserver.kind === "absent") return `📐 ${stagingObserver.describe}`;
      if (stagingDeletionDeadlineMs === undefined) {
        return (
          "📐 SCVS_E2E_STAGING_DELETION_DEADLINE_MS is unset. HA2 is a deadline assertion and the " +
          "deadline is an approved operational criterion for the environment, not a value this suite " +
          "may pick — see E2E-SRC.md precondition 5"
        );
      }
      return undefined;
    },
  },
  () => {
    for (const row of rows) {
      rowTest(
        `/${row.suffix}`,
        row.unavailable,
        async () => {
          const deadlineMs = stagingDeletionDeadlineMs!;

          // ── Step 1: upload, with no public declaration anywhere ────────────────────────────────
          // Visibility is declared on the verification manifest, never on the upload call, so this request
          // cannot express it and its absence here proves nothing on its own.
          const upload = await uploadFixtureArchive(row.fixtureId);
          const uploadedAt = Date.now();
          // The staging key's last component.
          expect(typeof upload.filename).toBe("string");
          expect(upload.filename.length).toBeGreaterThan(0);
          // The service's own count of what it received, against what was read off disk.
          expect(upload.size_bytes).toBe(upload.localBytes);

          const ttlMs = Date.parse(upload.expires_at) - uploadedAt;
          expect(ttlMs).toBeGreaterThan(0);
          // Precondition 5, checked against the deployment's own TTL rather than an assumed one.
          if (deadlineMs > ttlMs * MAX_DEADLINE_FRACTION_OF_TTL) {
            throw new Error(
              `SCVS_E2E_STAGING_DELETION_DEADLINE_MS=${deadlineMs} is not far enough inside this ` +
                `upload's own TTL (${ttlMs} ms, from expires_at=${upload.expires_at}). At that ratio ` +
                `the 30-minute expiry sweep could be what satisfied HA2, so the case would no longer ` +
                `be about job termination. Use at most ${Math.floor(
                  ttlMs * MAX_DEADLINE_FRACTION_OF_TTL
                )} ms.`
            );
          }

          // ── Step 2 / HA1: the exact object exists, and is the length we uploaded ───────────────
          // This validates the observation method and the independently-derived key before anything is asserted
          // about absence.
          const before = await observeStagedUpload(upload.upload_id, upload.filename);
          expectObservable(before, "step 2 (pre-submission existence)");
          expect(before.state).toBe("exists");
          if (before.state === "exists" && before.bytes !== undefined) {
            expect(before.bytes).toBe(upload.size_bytes);
          }

          // ── Step 3: submit, private ────────────────────────────────────────────────────────────
          const body = await submissionFor(row.fixtureId, {
            ...(row.target ? { target: row.target } : {}),
            upload_id: upload.upload_id,
            source_sha256: upload.source_sha256,
            is_public: false,
          });
          delete (body.manifest as { source_uri?: string }).source_uri;

          // ── Step 4: poll to the row's terminal state ───────────────────────────────────────────
          const run = await submitAndWait(body);
          const terminalAt = Date.now();
          expect(run.body.status).toBe(row.terminalStatus);
          if (row.expectedError) expect(run.body.error).toBe(row.expectedError);

          // ── Step 5 / HA2: gone within the approved deadline ───────────────────────────────────
          const absence = await waitForStagedUploadAbsence(upload.upload_id, upload.filename, {
            deadlineMs,
            since: terminalAt,
          });
          console.log(
            `[E2E-SRC-03/${row.suffix}] ${absence.last.key}: ${
              absence.absent ? `absent after ${absence.latencyMs} ms` : "STILL PRESENT"
            } (deadline ${deadlineMs} ms, upload TTL ${ttlMs} ms, observer: ${stagingObserver.describe})`
          );
          expect(absence.absent).toBe(true);
          expect(absence.latencyMs).toBeLessThanOrEqual(deadlineMs);
          // And comfortably before the TTL could have been responsible.
          expect(Date.now()).toBeLessThan(Date.parse(upload.expires_at));

          // ── Step 6 / Diagnostic 1: the handle cannot be reused ────────────────────────────────
          // Ordered after HA2 on purpose. It is DB-row evidence, it is not accepted for HA2, and it is mildly
          // destructive: if the row survived, this creates a real second job.
          const reuse = await submit(body);
          expect(reuse.jobId).toBeUndefined();
          expect(reuse.response.status).toBe(400);
          expect(reuse.response.json?.error).toBe("upload_not_found");

          // ── Step 7 / HA3: the private source never entered published storage ──────────────────
          // Keyed on this submission's own `source_sha256`.
          for (const name of [
            `${upload.source_sha256}.tar.gz`,
            `${upload.source_sha256}.tgz`,
            upload.source_sha256,
          ]) {
            const fetched = await http(staticSourceUrl(name));
            expect([403, 404]).toContain(fetched.status);
          }

          // ── Step 8 / HA4: the commitment survives, the declaration stays private ──────────────
          // Conditional by design: a failed job is not required to mint a report, so the `/on_verified` and
          // `/on_mismatched` rows carry this and `/on_build_failed` legitimately does not.
          if (run.body.result?.artifact_url) {
            const { artifact } = await readReportByUrl(run.body.result.artifact_url);
            expect(artifact.source).toBeDefined();
            expect(artifact.source!.source_sha256).toBe(upload.source_sha256);
            expect(artifact.source!.is_public).toBe(false);
            // The retained-source link is the one structural difference, and its absence is the published form
            // of "private".
            expect(artifact.source!.source_file_name).toBeUndefined();
          }

          const wasmHash = run.body.result?.wasm_hash;
          if (wasmHash) {
            const status = await readStatusObject(wasmHash);
            if (status.found) {
              for (const entry of status.object.source_code_verifications) {
                if (entry.tarball_sha256 === upload.source_sha256) {
                  expect(entry.verified_source_code_uris).toBeUndefined();
                }
              }
            }
          }
        },
        // Two Batch round-trips for a failing row (`cli_failure` is retried once in build mode) plus the
        // deletion deadline plus the absence poll.
        2 * env.jobTimeoutMs + (stagingDeletionDeadlineMs ?? 0) + 120_000
      );
    }
  }
);
