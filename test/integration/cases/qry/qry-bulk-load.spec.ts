import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture } from "../../support/fixtures.js";
import { expectStatus, http, sleep } from "../../support/http.js";
import { aggregatedBulkLoadUrl } from "../../support/routes.js";
import type { AggregatedWasmStatus, BulkLoadPage } from "../../support/types.js";

const POLL_INTERVAL_MS = 3_000;
const MAX_PAGES = 200;
/**
 * Pages of one made `MAX_PAGES` a ceiling on the corpus itself, and the index gains a row every CI run
 * (constraint 2).
 */
const PAGE_LIMIT = 10;

const MULTI_VERIFIER_FIXTURE = "F-LEG-1";
const STREAM_FIXTURES = ["F-LEG-1", "F-LEG-3"] as const;

/** The keyset the aggregate pages by: `{timestampMs}-{wasm_hash}` over the index's own clock. */
interface CursorKey {
  readonly timestampMs: number;
  readonly wasmHash: string;
  readonly raw: string;
}

function parseCursor(raw: string): CursorKey {
  const match = /^(\d+)-([0-9a-f]{64})$/.exec(raw);
  if (!match) throw new Error(`E2E-QRY-08: aggregate cursor is not {timestampMs}-{wasm_hash}: ${raw}`);
  return { timestampMs: Number(match[1]), wasmHash: match[2], raw };
}

/** Strictly after, over the pair — equal timestamps are legal, an equal pair is not. */
function advances(previous: CursorKey, next: CursorKey): boolean {
  if (next.timestampMs !== previous.timestampMs) return next.timestampMs > previous.timestampMs;
  return next.wasmHash > previous.wasmHash;
}

interface Walk {
  readonly records: AggregatedWasmStatus[];
  /** One per page that returned a cursor, in stream order, paired with that page's last hash. */
  readonly cursors: { key: CursorKey; lastHashOnPage: string }[];
}

/** One full walk of the aggregate stream, keeping the cursors so the ordering can be asserted. */
async function walkAggregate(): Promise<Walk | undefined> {
  const records: AggregatedWasmStatus[] = [];
  const cursors: { key: CursorKey; lastHashOnPage: string }[] = [];
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const response = await http(aggregatedBulkLoadUrl({ order: "asc", limit: PAGE_LIMIT, cursor }));
    if (response.status === 503) return undefined;
    expectStatus(response, 200);
    const page = response.json as BulkLoadPage & { records: AggregatedWasmStatus[] };
    expect(page.order).toBe("asc");
    expect(page.records.length).toBeLessThanOrEqual(PAGE_LIMIT);
    records.push(...page.records);
    if (!page.cursor) return { records, cursors };
    const lastOnPage = page.records.at(-1);
    // A cursor with no row to key it would make the walk unfalsifiable — BL4 pairs the two.
    expect(lastOnPage).toBeDefined();
    cursors.push({ key: parseCursor(page.cursor), lastHashOnPage: lastOnPage!.wasm_hash });
    cursor = page.cursor;
  }

  throw new Error(
    `E2E-QRY-08 exceeded ${MAX_PAGES} pages of ${PAGE_LIMIT} (${MAX_PAGES * PAGE_LIMIT} records); ` +
      "the aggregate cursor did not terminate, or the corpus has outgrown this walk.",
  );
}

function synchronizationDiagnostic(
  expectedHashes: ReadonlySet<string>,
  multiVerifierHash: string,
  walk: Walk,
): string {
  const matching = walk.records.filter((record) => expectedHashes.has(record.wasm_hash));
  return JSON.stringify({
    multi_verifier_hash: multiVerifierHash,
    multi_verifier_note:
      `Only ${MULTI_VERIFIER_FIXTURE} is held to the two-entry bar; F-LEG-3's hash is unique to this ` +
      "run (SCVS_FIXTURE_BUILD_VARIANT). See E2E-QRY-08 constraint 2.",
    // Observation-only: no submission, and the Query API exposes no job lookup by Wasm hash.
    job_id: null,
    stream_records: walk.records.length,
    cursor_keys: walk.cursors.slice(0, 8).map((entry) => entry.key.raw),
    targets: [...expectedHashes].map((wasmHash) => {
      const record = matching.find((candidate) => candidate.wasm_hash === wasmHash);
      return {
        wasm_hash: wasmHash,
        holds_two_entry_bar: wasmHash === multiVerifierHash,
        ...(record
          ? {
              updated_at: record.updated_at,
              entry_count: record.source_code_verifications.length,
              verifiers: record.source_code_verifications.map((entry) => ({
                verifier: entry.verifier.url,
                name: entry.verifier.name,
                status: entry.status,
                processed_at: entry.processed_at,
                retrieved_at: entry.retrieved_at,
              })),
              unavailable_verifiers: record.unavailable_verifiers,
            }
          : { aggregate_record: "missing" }),
      };
    }),
  });
}

caseBlock(
  {
    id: "E2E-QRY-08/paginates_by_our_clock",
    title: "the aggregate bulk stream pages two independent verifier results by our update clock",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1", "P2"],
    unless: () => missingFixture(...STREAM_FIXTURES),
  },
  () => {
    it(
      "walks the keyset stream in cursor order, without duplicate hashes, once the peer result lands",
      async () => {
        const expectedHashes = new Set(STREAM_FIXTURES.map((id) => fixtures.contracts[id].wasm_hash!));
        const multiVerifierHash = fixtures.contracts[MULTI_VERIFIER_FIXTURE].wasm_hash!;

        const deadline = Date.now() + env.jobTimeoutMs;
        let walk: Walk = { records: [], cursors: [] };

        const satisfied = (found: Walk): boolean => {
          const matching = found.records.filter((record) => expectedHashes.has(record.wasm_hash));
          if (matching.length !== expectedHashes.size) return false;
          const multi = matching.find((record) => record.wasm_hash === multiVerifierHash);
          return (multi?.source_code_verifications.length ?? 0) >= 2;
        };

        while (Date.now() < deadline) {
          walk = (await walkAggregate()) ?? { records: [], cursors: [] };
          if (walk.records.length > 0 && satisfied(walk)) break;
          await sleep(POLL_INTERVAL_MS);
        }

        const matching = walk.records.filter((record) => expectedHashes.has(record.wasm_hash));
        if (!satisfied(walk)) {
          const missing = [...expectedHashes].filter(
            (hash) => !matching.some((record) => record.wasm_hash === hash),
          );
          const reason =
            missing.length > 0
              ? `${missing.length} of ${expectedHashes.size} fixture hashes never reached the aggregate stream`
              : `${multiVerifierHash} never carried two verifier entries`;
          throw new Error(
            `E2E-QRY-08 did not converge within ${env.jobTimeoutMs} ms: ${reason}. Diagnostic: ` +
              synchronizationDiagnostic(expectedHashes, multiVerifierHash, walk),
          );
        }

        // HA1 — the keyset walk visits every fixture exactly once and never repeats a hash across the whole
        // stream, which is where a cursor re-emitting its boundary row surfaces.
        expect(matching.map((record) => record.wasm_hash).sort()).toEqual([...expectedHashes].sort());
        expect(new Set(walk.records.map((record) => record.wasm_hash)).size).toBe(walk.records.length);

        // HA2 — the stream is keyed and ordered by one clock. `updated_at` on a record is assembly time
        // (`assemble`), identical on every row; the cursor carries `aggregationUpdatedAt`.
        expect(walk.cursors.length).toBeGreaterThan(1);
        for (const [index, entry] of walk.cursors.entries()) {
          expect(entry.key.wasmHash).toBe(entry.lastHashOnPage);
          if (index > 0) expect(advances(walk.cursors[index - 1].key, entry.key)).toBe(true);
        }

        // HA3 — two verifier entries on the stable hash. Arity only: *which* member supplied an entry is
        // E2E-SUB-01's assertion, which polls the per-hash aggregate for our own entry.
        const multi = matching.find((record) => record.wasm_hash === multiVerifierHash)!;
        expect(multi.source_code_verifications.length).toBeGreaterThanOrEqual(2);
      },
      env.jobTimeoutMs + 60_000,
    );
  },
);
