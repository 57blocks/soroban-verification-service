/**
 * E2E-SEC-09 and E2E-SEC-10. P8 supplies observations that the public API must not disclose: build-fleet
 * IAM/network state and credential-bearing upload URLs.
 */
import { randomUUID } from "node:crypto";

import { caseBlock } from "../../support/gate.js";
import { http, sleep } from "../../support/http.js";
import { readSec09Evidence, readSec10Capture } from "../../support/security-probes.js";

const REJECTED_PUT_BODY = new TextEncoder().encode(`SCVS-SEC-10-replay-${randomUUID()}`);
const CONTROL_PUT_BODY = new TextEncoder().encode(`SCVS-SEC-10-control-${randomUUID()}`);
const EXPIRY_GRACE_MS = 60_000;

caseBlock(
  {
    id: "E2E-SEC-09",
    title: "the build cluster has no database, result-root, or publishing capability",
    mode: "AUTO-INFRA",
    needs: ["SCVS_E2E_SEC09_EVIDENCE_PATH", "SCVS_E2E_SEC09_JOB_ID"],
    prerequisites: ["P1", "P8"],
  },
  () => {
    it("binds P8's denial evidence to the diagnostic Batch job and rejects every business capability", () => {
      const evidence = readSec09Evidence();
      expect(evidence.jobId).toBe(process.env.SCVS_E2E_SEC09_JOB_ID);
      expect(evidence.database.credentialPresent).toBe(false);
      expect(["denied", "unreachable"]).toContain(evidence.database.outcome);
      expect(evidence.resultBucket).toEqual({ get: "denied", put: "denied" });
      expect(evidence.publishingKey).toEqual({
        environment: false,
        credentialsFile: false,
        imds: "unreachable",
        mountedSecrets: false,
      });
      expect(evidence.unexpectedOutboundDestinations).toEqual([]);
    });
  }
);

caseBlock(
  {
    id: "E2E-SEC-10",
    title: "each sandbox upload URL is write-only, one-shot, and expires on schedule",
    mode: "AUTO-INFRA",
    needs: ["SCVS_E2E_SEC10_CAPTURE_PATH", "SCVS_E2E_UPLOAD_URL_TTL_MS"],
    prerequisites: ["P1", "P8"],
    unless: () => {
      const ttl = Number(process.env.SCVS_E2E_UPLOAD_URL_TTL_MS);
      return Number.isFinite(ttl) && ttl > 0
        ? undefined
        : "SCVS_E2E_UPLOAD_URL_TTL_MS must be the deployment's positive TTL_UPLOAD_URL value";
    },
  },
  () => {
    it("rejects a second PUT to each consumed sandbox output target", async () => {
      const capture = readSec10Capture();
      for (const target of Object.values(capture.targets)) {
        expect(target.consumedAtMs).toBeLessThanOrEqual(Date.now());
        const replay = await http(target.url, {
          method: "PUT",
          // Preserve every signed header. Changing content type would test SigV4 header binding, not the
          // one-write property: recipe.json is signed as JSON, rebuilt.wasm as Wasm.
          headers: { "content-type": target.contentType },
          body: REJECTED_PUT_BODY,
          bare: true,
        });
        // A 2xx here means the sandbox can overwrite a trusted-side-read output before expiry.
        expect(replay.ok).toBe(false);
      }
    });

    it("does not grant GET access to either upload target", async () => {
      const capture = readSec10Capture();
      for (const target of Object.values(capture.targets)) {
        const read = await http(target.url, { method: "GET", bare: true });
        // Error bodies may intentionally conceal object existence; success is the only unsafe outcome.
        expect(read.ok).toBe(false);
      }
    });

    it(
      "accepts a disposable control PUT before expiry and rejects it after the published TTL",
      async () => {
        const capture = readSec10Capture();
        const ttlMs = Number(process.env.SCVS_E2E_UPLOAD_URL_TTL_MS);
        expect(capture.control.expiresAtMs - capture.capturedAtMs).toBeLessThanOrEqual(ttlMs + 5_000);

        // The control URL uses the same signer policy but is not a builder output, so this positive control
        // cannot corrupt the terminal job inspected by the two negative rows above.
        const withinTtl = await http(capture.control.url, {
          method: "PUT",
          headers: { "content-type": capture.control.contentType },
          body: CONTROL_PUT_BODY,
          bare: true,
        });
        expect(withinTtl.ok).toBe(true);

        const waitMs = capture.control.expiresAtMs + EXPIRY_GRACE_MS - Date.now();
        if (waitMs > 0) await sleep(waitMs);
        const expired = await http(capture.control.url, {
          method: "PUT",
          headers: { "content-type": capture.control.contentType },
          body: REJECTED_PUT_BODY,
          bare: true,
        });
        expect(expired.ok).toBe(false);
      },
      25 * 60_000
    );
  }
);
