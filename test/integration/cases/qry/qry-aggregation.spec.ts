/**
 * E2E-QRY-01 — list each verifier without merging The design commitment: this service aggregates, it does not
 * adjudicate.
 */
import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { expectStatus, http } from "../../support/http.js";
import { submitAndWait } from "../../support/job.js";
import { aggregatedByHashUrl, verifiersUrl } from "../../support/routes.js";
import { normalizeResultRoot } from "../../support/result-tree.js";
import type { AggregatedWasmStatus, TrustedVerifiersList } from "../../support/types.js";

caseBlock(
  {
    id: "E2E-QRY-01",
    title: "each verifier appears in its own right; there is no merged verdict",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL", "SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1", "P2"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it(
      "returns per-verifier entries and no top-level verdict field",
      async () => {
        const tvlResponse = await http(verifiersUrl());
        expectStatus(tvlResponse, 200);
        // By result root, not by display name. `aggregation-read.service.ts` relays the peer's own
        // `verifier` block verbatim (CV11), so the `name` on an entry is that verifier's self-claim
        // and not the label this list happens to use for it. The root is the identity, and it is the
        // one field the two lists are guaranteed to agree on.
        const expectedRoots = (tvlResponse.json as TrustedVerifiersList).verifiers
          .filter((verifier) => verifier.status === "active")
          .map((verifier) => normalizeResultRoot(verifier.url));
        expect(expectedRoots.length).toBeGreaterThanOrEqual(2);
        const run = await submitAndWait(await submissionFor("F-LEG-1"));
        const hash = run.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-1"].wasm_hash!;

        const response = await http(aggregatedByHashUrl(hash));
        expectStatus(response, 200);
        const body = response.json as AggregatedWasmStatus;

        // The runner's normal P1/P2 setup supplies two same-policy independent verifiers.
        expect(body.source_code_verifications.length).toBeGreaterThanOrEqual(2);
        expect(
          body.source_code_verifications.map((entry) => normalizeResultRoot(entry.verifier?.url ?? "")),
        ).toEqual(expect.arrayContaining(expectedRoots));

        // HA2 — each entry carries its own identity and its own status.
        for (const entry of body.source_code_verifications) {
          expect(typeof entry.verifier?.url).toBe("string");
          expect(["verified", "mismatched", "unverified"]).toContain(entry.status);
        }

        // HA3 — no top-level verdict. Named explicitly rather than by a generic shape check, because the
        // failure mode is someone helpfully adding one.
        for (const forbidden of ["status", "verdict", "result", "verified", "conclusion"]) {
          expect(body as unknown as Record<string, unknown>).not.toHaveProperty(forbidden);
        }
      },
      env.jobTimeoutMs + 60_000,
    );
  },
);
