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

        expectMarker(observation, true);

        expect(artifact.trust).toBeDefined();
        expect(Object.keys(artifact.trust)).toContain("sep55_attestation_present");

        expectSingleMarkerRepresentation(observation);

        const rebuilt = artifact.result.rebuilt_wasm_hash?.toLowerCase();
        const deployed = artifact.result.wasm_hash?.toLowerCase();
        expect(typeof artifact.result.matched).toBe("boolean");
        expect(artifact.result.matched).toBe(rebuilt !== undefined && rebuilt === deployed);

        expect(observation.terminal.body.status).toBe(
          artifact.result.matched ? "verified" : "mismatch",
        );

        expect(deployed).toBe(observation.wasmHash.toLowerCase());
      },
      MARKER_CASE_TIMEOUT_MS,
    );
  },
);
