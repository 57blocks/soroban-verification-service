import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGGREGATE_SCHEMA,
  AggregatedWasmStatus,
  OwnBulkLoadPage,
  PAGE_SCHEMA,
  PeerBulkLoadPage,
} from "./aggregate.js";
import { parseDto, safeParseDto } from "./validate.js";

// A standalone script, like `registry-test.ts` — no package under `packages/` has a Jest setup.

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "../../../docs/results-sep/schemas/stellar-verification-page-1.0.schema.json");

const record = { wasm_hash: "a".repeat(64), updated_at: "2026-09-03T00:00:00.000Z" };
const page = {
  schema: PAGE_SCHEMA,
  schema_version: "1.0",
  order: "asc",
  cursor: null,
  records: [record],
};

function rejects(value: unknown, why: string): void {
  assert.equal(safeParseDto(OwnBulkLoadPage, value).success, false, why);
}

function main(): void {
  // ── the producer document ────────────────────────────────────────────────────────────────────
  const parsed = parseDto(OwnBulkLoadPage, page);
  assert.equal(parsed.schema, "stellar-verification-page");
  assert.equal(parsed.records[0]?.wasm_hash, record.wasm_hash);

  rejects({ ...page, schema: undefined }, "a page we serve names its document type");
  rejects({ ...page, schema: "stellar-verification-status" }, "and names the right one");
  rejects({ ...page, schema_version: "1.1" }, "we publish exactly 1.0, whatever we tolerate on read");
  rejects({ ...page, order: "ascending" }, "order echoes back what was asked, from a closed set");
  rejects({ ...page, cursor: 7 }, "a cursor is a string or null");

  // ── the consumer document ────────────────────────────────────────────────────────────────────
  // A verifier that has not cut over publishes no `schema`. Rejecting it here would make every unmigrated peer
  // `invalid_response` and drop it from the aggregate.
  const legacy = { schema_version: "1.0", order: "asc", cursor: null, records: [record] };
  assert.equal(parseDto(PeerBulkLoadPage, legacy).schema, undefined);

  // SO7: branch on MAJOR, tolerate a higher MINOR.
  assert.equal(parseDto(PeerBulkLoadPage, { ...legacy, schema_version: "1.7" }).schema_version, "1.7");
  assert.equal(
    safeParseDto(PeerBulkLoadPage, { ...legacy, schema_version: "2.0" }).success,
    false,
    "a different MAJOR may have redefined a field we read; tolerating it would restate a peer's claim",
  );
  assert.equal(safeParseDto(PeerBulkLoadPage, { ...legacy, schema_version: "1" }).success, false);

  // CV8: an unrecognised field is kept, not a reason to reject the page.
  const extra = parseDto(PeerBulkLoadPage, { ...page, something_new: 1 }) as unknown as Record<string, unknown>;
  assert.equal(extra["something_new"], 1);

  // ── the schema file and the classes describe the same document ───────────────────────────────
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    properties: { schema: { const: string }; schema_version: { const: string } };
    required: string[];
    $defs: { reference_record: { required: string[] } };
  };
  assert.equal(schema.properties.schema.const, PAGE_SCHEMA);
  assert.equal(schema.properties.schema_version.const, "1.0");
  assert.deepEqual(schema.required, ["schema", "schema_version", "order", "cursor", "records"]);
  assert.deepEqual(schema.$defs.reference_record.required, ["wasm_hash", "updated_at"]);

  // ── the aggregate document ───────────────────────────────────────────────────────────────────
  const relayed = {
    // The peer's own block, unchanged. `url` identifies; `name` is what they call themselves.
    verifier: { url: "https://peer.example/", name: "As They Name Themselves" },
    schema_version: "1.3",
    status: "verified",
    retrieved_at: "2026-09-03T00:00:00.000Z",
  };
  const aggregate = {
    schema: AGGREGATE_SCHEMA,
    schema_version: "1.0",
    wasm_hash: "b".repeat(64),
    updated_at: "2026-09-03T00:00:00.000Z",
    source_code_verifications: [relayed],
    unavailable_verifiers: [],
    agreement: "single",
  };

  const parsedAggregate = parseDto(AggregatedWasmStatus, aggregate);
  assert.equal(parsedAggregate.schema, "stellar-verification-aggregate");

  // An aggregator that made them agree would be re-versioning a claim it only passes on.
  assert.equal(parsedAggregate.schema_version, "1.0");
  assert.equal(parsedAggregate.source_code_verifications[0]?.schema_version, "1.3");

  // CV11: the peer's own block is relayed unchanged. There is no second identity and no aggregator-local id —
  // the result root is the identity, so nothing needs asserting.
  assert.equal(parsedAggregate.source_code_verifications[0]?.verifier.url, "https://peer.example/");
  assert.equal(parsedAggregate.source_code_verifications[0]?.verifier.name, "As They Name Themselves");

  assert.equal(
    safeParseDto(AggregatedWasmStatus, { ...aggregate, schema: undefined }).success,
    false,
    "an aggregate names its document type — the draft's shared `1.0` is what made two documents look alike",
  );
  assert.equal(
    safeParseDto(AggregatedWasmStatus, {
      ...aggregate,
      source_code_verifications: [{ ...relayed, verifier: { name: "Nameless Root" } }],
    }).success,
    false,
    "a relayed entry carries the result root it came from; a name identifies nothing",
  );

  const aggregateSchema = JSON.parse(
    readFileSync(
      resolve(here, "../../../docs/results-sep/schemas/stellar-verification-aggregate-1.0.schema.json"),
      "utf8",
    ),
  ) as { properties: { schema: { const: string } }; $defs: { relayed_verification: { required: string[] } } };
  assert.equal(aggregateSchema.properties.schema.const, AGGREGATE_SCHEMA);
  assert.deepEqual(aggregateSchema.$defs.relayed_verification.required, ["verifier", "status"]);

  console.log(
    "Bulk-load page + aggregate: producer/consumer split, SO7 MAJOR-branching, CV8 preservation, " +
      "CV11 relay of the peer identity, envelope-vs-entry versioning, schema file agreement passed",
  );
}

main();
