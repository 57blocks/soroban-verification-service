/** E2E-SEP55-03 — the discriminator is **begins with** `github:`, not **contains** it */
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
  /** The semantic suffix from the case file's parameter table. */
  readonly suffix: string;
  readonly fixtureId: string;
  /** The on-chain `source_repo` value, restated so the row reads without the inventory open. */
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
    // The persistent rows establish the common E2E prerequisites. Run-scoped boundary rows name a
    // missing fixture individually when this is not the CI inventory.
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

          // ── The hard assertion the whole row exists for ──────────────────────────────────────
          expectMarker(observation, row.expected);

          // A `false` marker is still one field in one place.
          expectSingleMarkerRepresentation(observation);

          // ── Shared step 3, as far as open item 2 allows ──────────────────────────────────────
          // The verdict published at all, so retrieval succeeded — and it cannot have used the `source_repo`
          // value, whose host does not resolve.
          expect(observation.terminal.body.status).not.toBe("source_unavailable");
          expect(artifact.source?.is_public).toBe(true);
          expect(artifact.source?.source_sha256).toBe(fixture(fixtureId).source_sha256);
          expect(artifact.source?.source_uri).toBe(fixture(fixtureId).source_uri);
          expect(artifact.source?.source_uri).not.toBe(row.sourceRepo);

          // ── The other half of SEP55-01's HA3 ────────────────────────────────────────────────
          // Same source and recipe, with only the observed metadata value changed: the verdict is
          // still exactly the byte comparison, so the marker did not move it.
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
