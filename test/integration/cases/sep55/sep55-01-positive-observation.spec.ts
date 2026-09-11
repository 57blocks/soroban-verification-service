/** E2E-SEP55-01 — a SEP-55 marker is recorded accurately, and does nothing else */
import { missingDeployedTarget } from "../../support/fixtures.js";
import { caseBlock } from "../../support/gate.js";
import {
  expectMarker,
  expectSingleMarkerRepresentation,
  observeMarker,
  MARKER_CASE_TIMEOUT_MS,
} from "./marker.js";

const CASE_ID = "E2E-SEP55-01";
const FIXTURE = "F-S55-A";

caseBlock(
  {
    id: CASE_ID,
    title: "a github:-prefixed source_repo is observed as present, in trust, and changes no verdict",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget(FIXTURE),
  },
  () => {
    it(
      "★ records trust.sep55_attestation_present == true, once, without touching the verdict",
      async () => {
        const observation = await observeMarker(FIXTURE, CASE_ID);
        const { artifact } = observation;

        // ── HA1 — the observation itself ───────────────────────────────────────────────────────
        // `github:example/contract` sits in the CLI-injected `contractmetav0` section beside `cliver`, so
        // `planMetadataReplay` carries it into `metadata_replay` and the publisher reads it from there.
        expectMarker(observation, true);

        // ── HA2 — the field's place ────────────────────────────────────────────────────────────
        expect(artifact.trust).toBeDefined();
        expect(Object.keys(artifact.trust)).toContain("sep55_attestation_present");

        // HA2's second half — "next to the other three trust signals" — is deliberately not asserted.
        expectSingleMarkerRepresentation(observation);

        // ── HA3 — the verdict is a hash comparison and nothing else ────────────────────────────
        // Not assertable as `verified` on a marked contract alone: that is also what a marker-influenced
        // verdict looks like.
        const rebuilt = artifact.result.rebuilt_wasm_hash?.toLowerCase();
        const deployed = artifact.result.wasm_hash?.toLowerCase();
        expect(typeof artifact.result.matched).toBe("boolean");
        expect(artifact.result.matched).toBe(rebuilt !== undefined && rebuilt === deployed);

        // And the wire verdict is that same comparison, not a third opinion.
        expect(observation.terminal.body.status).toBe(
          artifact.result.matched ? "verified" : "mismatch",
        );

        // The report is about the contract that was submitted — guards against reading a report belonging to
        // another case on a shared hash.
        expect(deployed).toBe(observation.wasmHash.toLowerCase());
      },
      MARKER_CASE_TIMEOUT_MS,
    );
  },
);
