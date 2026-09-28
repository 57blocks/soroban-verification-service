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
  const parsed = parseDto(OwnBulkLoadPage, page);
  assert.equal(parsed.schema, "stellar-verification-page");
  assert.equal(parsed.records[0]?.wasm_hash, record.wasm_hash);

  rejects({ ...page, schema: undefined }, "a page we serve names its document type");
  rejects({ ...page, schema: "stellar-verification-status" }, "and names the right one");
  rejects({ ...page, schema_version: "1.1" }, "we publish exactly 1.0, whatever we tolerate on read");
  rejects({ ...page, order: "ascending" }, "order echoes back what was asked, from a closed set");
  rejects({ ...page, cursor: 7 }, "a cursor is a string or null");

  const legacy = { schema_version: "1.0", order: "asc", cursor: null, records: [record] };
  assert.equal(parseDto(PeerBulkLoadPage, legacy).schema, undefined);

  assert.equal(parseDto(PeerBulkLoadPage, { ...legacy, schema_version: "1.7" }).schema_version, "1.7");
  assert.equal(
    safeParseDto(PeerBulkLoadPage, { ...legacy, schema_version: "2.0" }).success,
    false,
    "a different MAJOR may have redefined a field we read; tolerating it would restate a peer's claim",
  );
  assert.equal(safeParseDto(PeerBulkLoadPage, { ...legacy, schema_version: "1" }).success, false);

  const extra = parseDto(PeerBulkLoadPage, { ...page, something_new: 1 }) as unknown as Record<string, unknown>;
  assert.equal(extra["something_new"], 1);

  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    properties: { schema: { const: string }; schema_version: { const: string } };
    required: string[];
    $defs: { reference_record: { required: string[] } };
  };
  assert.equal(schema.properties.schema.const, PAGE_SCHEMA);
  assert.equal(schema.properties.schema_version.const, "1.0");
  assert.deepEqual(schema.required, ["schema", "schema_version", "order", "cursor", "records"]);
  assert.deepEqual(schema.$defs.reference_record.required, ["wasm_hash", "updated_at"]);

  const relayed = {
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

  assert.equal(parsedAggregate.schema_version, "1.0");
  assert.equal(parsedAggregate.source_code_verifications[0]?.schema_version, "1.3");

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
