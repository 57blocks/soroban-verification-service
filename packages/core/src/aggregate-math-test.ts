import assert from "node:assert/strict";
import {
  AGGREGATE_SCHEMA,
  AGGREGATE_SCHEMA_VERSION,
  aggregateEnvelope,
  computeAgreement,
  displayStatusOf,
  type AggregatedRegistryVerification,
} from "./aggregate.js";
import type { PeerRegistryVerification } from "./registry.js";
import { parseDto } from "./validate.js";
import { AggregatedWasmStatus } from "./aggregate.js";

function entry(status: string): PeerRegistryVerification {
  return { status, verifier: { url: "https://v.test" } } as unknown as PeerRegistryVerification;
}

function test(name: string, fn: () => void): void {
  fn();
  console.log(`ok - ${name}`);
}

test("no entries is no_data, and one entry is single rather than unanimous", () => {
  assert.equal(computeAgreement([]), "no_data");
  assert.equal(computeAgreement([entry("verified")]), "single");
  assert.equal(computeAgreement([entry("mismatched")]), "single");
});

test("agreement among two or more", () => {
  assert.equal(computeAgreement([entry("verified"), entry("verified")]), "unanimous_verified");
  assert.equal(computeAgreement([entry("mismatched"), entry("mismatched")]), "unanimous_mismatched");
  assert.equal(computeAgreement([entry("verified"), entry("mismatched")]), "disputed");
  assert.equal(computeAgreement([entry("unverified"), entry("unverified")]), "unverified_only");
});

test("an unrecognised status counts as unverified, never as its own value", () => {
  assert.equal(displayStatusOf(entry("something-a-later-draft-added")), "unverified");
  assert.equal(computeAgreement([entry("verified"), entry("something-later")]), "unverified_only");
  assert.equal(computeAgreement([entry("something-later"), entry("also-later")]), "unverified_only");
});

test("disputed survives an extra unverified entry", () => {
  assert.equal(
    computeAgreement([entry("verified"), entry("mismatched"), entry("unverified")]),
    "disputed",
  );
});

test("the envelope is the shape the DTO accepts", () => {
  const envelope = aggregateEnvelope({
    wasmHash: "a".repeat(64),
    entries: [entry("verified") as AggregatedRegistryVerification],
    unavailableVerifiers: [{ url: "https://down.test", reason: "timeout", error: "took too long" }],
  });
  assert.equal(envelope.schema, AGGREGATE_SCHEMA);
  assert.equal(envelope.schema_version, AGGREGATE_SCHEMA_VERSION);
  assert.equal(envelope.agreement, "single");
  assert.equal(envelope.unavailable_verifiers.length, 1);
  assert.doesNotThrow(() => parseDto(AggregatedWasmStatus, envelope));
});

test("both lists are always present", () => {
  const envelope = aggregateEnvelope({ wasmHash: "b".repeat(64), entries: [], unavailableVerifiers: [] });
  assert.deepEqual(envelope.source_code_verifications, []);
  assert.deepEqual(envelope.unavailable_verifiers, []);
  assert.equal(envelope.agreement, "no_data");
});

test("the envelope copies the arrays it is given", () => {
  const entries: AggregatedRegistryVerification[] = [];
  const envelope = aggregateEnvelope({ wasmHash: "c".repeat(64), entries, unavailableVerifiers: [] });
  entries.push(entry("verified") as AggregatedRegistryVerification);
  assert.deepEqual(envelope.source_code_verifications, []);
});
