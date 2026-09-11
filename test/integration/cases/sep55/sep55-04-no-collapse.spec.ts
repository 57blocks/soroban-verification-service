/** E2E-SEP55-04 — attestation data is not folded into `source_code_verifications` */
import { linkUrls } from "../../support/types.js";
import { metadataSubmissionFor, missingDeployedTarget } from "../../support/fixtures.js";
import { caseBlock } from "../../support/gate.js";
import { expectStatus, http } from "../../support/http.js";
import { verifyWasmStatusUrl } from "../../support/routes.js";
import { ownEntryOf, ownVerifierIdentity, readReportByUrl } from "../../support/result-tree.js";
import type { RegistryStatusObject } from "../../support/types.js";
import {
  expectMarker,
  expectSingleMarkerRepresentation,
  observeMarker,
  MARKER_CASE_TIMEOUT_MS,
} from "./marker.js";

const CASE_ID = "E2E-SEP55-04";
const FIXTURE = "F-S55-D";

/** The published verdict vocabulary (SO1). Every row in the array must carry one of these. */
const REGISTRY_STATUSES = ["verified", "mismatched", "unverified"];

caseBlock(
  {
    id: CASE_ID,
    title: "a contract carrying both signals keeps them apart: no attestation entry in the array",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget(FIXTURE),
  },
  () => {
    it(
      "★ the SEP-55 marker stays a boolean in trust and never becomes a verification entry",
      async () => {
        // Target-only: the manifest is inferred from the chain's own complete SEP-58 recipe, which is the
        // coexistence shape.
        const observation = await observeMarker(FIXTURE, CASE_ID, {
          body: metadataSubmissionFor(FIXTURE),
        });

        // ── Step 1 — `GET /v1/wasms/{H}.json`, this verifier's own Registry document ────────────
        // The dynamic per-hash route, not the aggregate and not the static file: the case is about what *we*
        // publish for this hash.
        const response = await http(verifyWasmStatusUrl(observation.wasmHash));
        expectStatus(response, 200);
        const status = response.json as RegistryStatusObject;
        expect(status.wasm_hash.toLowerCase()).toBe(observation.wasmHash.toLowerCase());

        // ── Step 2 / HA1 — every row is a source verification ──────────────────────────────────
        const entries = status.source_code_verifications;
        expect(Array.isArray(entries)).toBe(true);
        // `minItems: 1` — an empty array is never published; "nothing here" is a 404.
        expect(entries.length).toBeGreaterThan(0);

        for (const entry of entries) {
          expect(REGISTRY_STATUSES).toContain(entry.status);
          // The identity, not the label: `verifier.url` is what the Results SEP requires and what a
          // consumer follows back to a manifest and a policy. `name` is optional and self-claimed.
          expect(typeof entry.verifier?.url).toBe("string");

          // An attestation row would have to name its repository somewhere, and SEP-58 v0.4.0's `source_repo`
          // is where it would land.
          expect(entry.source_repo).toBeUndefined();

          // Nor does any row invent an attestation vocabulary of its own.
          for (const key of Object.keys(entry)) {
            expect(key).not.toMatch(/sep55|attestation/i);
          }
        }

        // ── Step 3 / HA2 — one entry per verifier ──────────────────────────────────────────────
        // The case file's HA2 is "the array length equals the number of verifiers that actually performed
        // source verification". Keyed by result root: two verifiers may claim one `name`.
        const verifierRoots = entries.map((entry) => entry.verifier.url);
        expect(new Set(verifierRoots).size).toBe(entries.length);

        const ours = ownEntryOf(entries, await ownVerifierIdentity());
        expect(ours).toBeDefined();
        expect(REGISTRY_STATUSES).toContain(ours!.status);

        expect(JSON.stringify(status)).not.toMatch(/sep55/i);

        // ── Step 4 / HA3 — in the report: exactly once, in `trust` ─────────────────────────────
        // Placement, the case's actual subject, holds either way.
        expectMarker(observation, true);
        expectSingleMarkerRepresentation(observation);
        expect(Object.keys(observation.artifact.trust)).toContain("sep55_attestation_present");

        // That copy must say the same thing the submitter was handed.
        const pointer = linkUrls(ours!).find((url) => url.includes("/reports/"));
        expect(pointer).toBeDefined();
        const viaEntry = await readReportByUrl(pointer!);
        expect(viaEntry.artifact.trust.sep55_attestation_present).toBe(true);
        expect(JSON.stringify(viaEntry.artifact).match(/sep55/gi)?.length ?? 0).toBe(1);
      },
      MARKER_CASE_TIMEOUT_MS,
    );
  },
);
