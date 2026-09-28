import { fixture, missingDeployedTarget } from "../../support/fixtures.js";
import { caseBlock, rowTest } from "../../support/gate.js";
import {
  expectMarker,
  expectSingleMarkerRepresentation,
  observeMarker,
  MARKER_CASE_TIMEOUT_MS,
} from "./marker.js";

const CASE_ID = "E2E-SEP55-03";

interface DiscriminatorRow {
  readonly suffix: string;
  readonly fixtureId: string;
  readonly sourceRepo: string;
  readonly expected: boolean;
}

const ROWS: readonly DiscriminatorRow[] = [
  {
    suffix: "legacy_source_repo",
    fixtureId: "F-S55-B",
    sourceRepo: "https://example.com/src.tar.gz",
    expected: false,
  },
  {
    suffix: "contains_but_not_prefix",
    fixtureId: "F-S55-C",
    sourceRepo: "https://mirror.example.com/github:foo",
    expected: false,
  },
  {
    suffix: "case_variant",
    fixtureId: "F-S55-E",
    sourceRepo: "GitHub:foo/bar",
    expected: false,
  },
  {
    suffix: "empty_after_prefix",
    fixtureId: "F-S55-F",
    sourceRepo: "github:",
    expected: true,
  },
];

caseBlock(
  {
    id: CASE_ID,
    title: "detection uses startsWith(\"github:\"), and legacy SEP-58 v0.4.0 vocabulary reads false",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget("F-S55-B", "F-S55-C"),
  },
  () => {
    for (const row of ROWS) {
      const claim = `reads ${row.expected}`;

      rowTest(
        `${CASE_ID}/${row.suffix} — source_repo=${row.sourceRepo} ${claim}`,
        missingDeployedTarget(row.fixtureId),
        async () => {
          const fixtureId = row.fixtureId;
          const observation = await observeMarker(fixtureId, `${CASE_ID}/${row.suffix}`, {
            isPublic: true,
          });
          const { artifact } = observation;

          expectMarker(observation, row.expected);

          expectSingleMarkerRepresentation(observation);

          expect(observation.terminal.body.status).not.toBe("source_unavailable");
          expect(artifact.source?.is_public).toBe(true);
          expect(artifact.source?.source_sha256).toBe(fixture(fixtureId).source_sha256);
          expect(artifact.source?.source_uri).toBe(fixture(fixtureId).source_uri);
          expect(artifact.source?.source_uri).not.toBe(row.sourceRepo);

          const rebuilt = artifact.result.rebuilt_wasm_hash?.toLowerCase();
          const deployed = artifact.result.wasm_hash?.toLowerCase();
          expect(artifact.result.matched).toBe(rebuilt !== undefined && rebuilt === deployed);
          expect(deployed).toBe(observation.wasmHash.toLowerCase());
        },
        MARKER_CASE_TIMEOUT_MS,
      );
    }
  },
);
