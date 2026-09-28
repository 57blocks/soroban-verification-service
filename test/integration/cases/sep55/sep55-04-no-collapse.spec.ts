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
        const observation = await observeMarker(FIXTURE, CASE_ID, {
          body: metadataSubmissionFor(FIXTURE),
        });

        const response = await http(verifyWasmStatusUrl(observation.wasmHash));
        expectStatus(response, 200);
        const status = response.json as RegistryStatusObject;
        expect(status.wasm_hash.toLowerCase()).toBe(observation.wasmHash.toLowerCase());

        const entries = status.source_code_verifications;
        expect(Array.isArray(entries)).toBe(true);
        expect(entries.length).toBeGreaterThan(0);

        for (const entry of entries) {
          expect(REGISTRY_STATUSES).toContain(entry.status);
          expect(typeof entry.verifier?.url).toBe("string");

          expect(entry.source_repo).toBeUndefined();

          for (const key of Object.keys(entry)) {
            expect(key).not.toMatch(/sep55|attestation/i);
          }
        }

        const verifierRoots = entries.map((entry) => entry.verifier.url);
        expect(new Set(verifierRoots).size).toBe(entries.length);

        const ours = ownEntryOf(entries, await ownVerifierIdentity());
        expect(ours).toBeDefined();
        expect(REGISTRY_STATUSES).toContain(ours!.status);

        expect(JSON.stringify(status)).not.toMatch(/sep55/i);

        expectMarker(observation, true);
        expectSingleMarkerRepresentation(observation);
        expect(Object.keys(observation.artifact.trust)).toContain("sep55_attestation_present");

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
