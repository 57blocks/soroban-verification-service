import assert from "node:assert/strict";
import {
  parseContractMetaSections,
  planMetadataReplay,
  recordedToolchainPair,
  WasmMetadataParseError,
  type ContractMetaEntry,
} from "./wasm-metadata.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("MR1/MR2/MR3: parses sections separately and replays only the cliver-bearing section", () => {
  const wasm = makeWasm([
    [
      ["Description", "A contract"],
      ["rsver", "1.86.0"],
      ["rssdkver", "22.0.0"],
    ],
    [
      ["cliver", "27.0.0"],
      ["bldimg", "docker.io/stellar/stellar-cli@sha256:" + "a".repeat(64)],
      ["source_sha256", "b".repeat(64)],
      ["bldopt", "--locked"],
      ["home_domain", "example.com"],
    ],
  ]);

  const sections = parseContractMetaSections(wasm);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0].entries.map((entry) => entry.key), [
    "Description",
    "rsver",
    "rssdkver",
  ]);

  const replay = planMetadataReplay(sections);
  assert.deepEqual(replay, {
    section_index: 1,
    metadata_replay: [
      "bldimg=docker.io/stellar/stellar-cli@sha256:" + "a".repeat(64),
      "source_sha256=" + "b".repeat(64),
      "bldopt=--locked",
      "home_domain=example.com",
    ],
    dropped_keys: ["cliver"],
    sep58: {
      bldimg: "docker.io/stellar/stellar-cli@sha256:" + "a".repeat(64),
      bldopt: ["--locked"],
      source_sha256: "b".repeat(64),
      raw_entries: sections[1].entries,
    },
  });
});

test("MR3: drops cliver, rsver, and rssdkver from a degenerate merged section", () => {
  const wasm = makeWasm([
    [
      ["cliver", "27.0.0"],
      ["rsver", "1.86.0"],
      ["rssdkver", "22.0.0"],
      ["bldimg", "docker.io/stellar/stellar-cli@sha256:" + "c".repeat(64)],
      ["source_uri", "https://example.com/source.tar.gz"],
      ["source_sha256", "d".repeat(64)],
      ["bldarg", "contract"],
      ["bldarg", "build"],
    ],
  ]);

  const replay = planMetadataReplay(parseContractMetaSections(wasm));
  assert.deepEqual(replay?.metadata_replay, [
    "bldimg=docker.io/stellar/stellar-cli@sha256:" + "c".repeat(64),
    "source_uri=https://example.com/source.tar.gz",
    "source_sha256=" + "d".repeat(64),
    "bldarg=contract",
    "bldarg=build",
  ]);
  assert.deepEqual(replay?.dropped_keys, ["cliver", "rsver", "rssdkver"]);
  assert.deepEqual(replay?.sep58.bldarg, ["contract", "build"]);
});

test("Decision: no cliver-bearing section produces no replay plan", () => {
  const wasm = makeWasm([
    [
      ["bldimg", "docker.io/stellar/stellar-cli@sha256:" + "e".repeat(64)],
      ["source_sha256", "f".repeat(64)],
    ],
  ]);

  assert.equal(planMetadataReplay(parseContractMetaSections(wasm)), undefined);
});

test("Safety: multiple cliver-bearing sections fail closed", () => {
  const wasm = makeWasm([
    [["cliver", "26.0.0"]],
    [["cliver", "27.0.0"]],
  ]);

  assert.throws(
    () => planMetadataReplay(parseContractMetaSections(wasm)),
    /Multiple contractmetav0 sections contain cliver/,
  );
});

test("Safety: duplicate single-value driver fields fail closed but repeated bldopt survives", () => {
  const duplicateBldimg = makeWasm([
    [
      ["cliver", "27.0.0"],
      ["bldimg", "docker.io/stellar/stellar-cli@sha256:" + "1".repeat(64)],
      ["bldimg", "docker.io/stellar/stellar-cli@sha256:" + "2".repeat(64)],
    ],
  ]);
  assert.throws(
    () => planMetadataReplay(parseContractMetaSections(duplicateBldimg)),
    /Duplicate bldimg entries/,
  );

  const repeatedBldopt = makeWasm([
    [
      ["cliver", "27.0.0"],
      ["bldopt", "--locked"],
      ["bldopt", "--optimize"],
    ],
  ]);
  assert.deepEqual(planMetadataReplay(parseContractMetaSections(repeatedBldopt))?.sep58.bldopt, [
    "--locked",
    "--optimize",
  ]);
});

test("Safety: malformed Wasm, unsupported discriminant, and truncated XDR fail closed", () => {
  assert.throws(
    () => parseContractMetaSections(new Uint8Array([0x00, 0x61, 0x73])),
    WasmMetadataParseError,
  );

  const unsupported = makeWasmFromPayload(writeU32(99));
  assert.throws(() => parseContractMetaSections(unsupported), /Unsupported SCMetaEntry discriminant/);

  const truncated = makeWasmFromPayload(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 10, 1]));
  assert.throws(() => parseContractMetaSections(truncated), /Unexpected end of input/);
});

test("recordedToolchainPair: combines SDK rsver and CLI cliver from separate sections", () => {
  const wasm = makeWasm([
    [
      ["Description", "A contract"],
      ["rsver", "1.94.1"],
      ["rssdkver", "22.0.0"],
    ],
    [
      ["cliver", "27.0.0#93e1b1671f14830662766c005138b19095fe9307"],
      ["bldopt", "--locked"],
    ],
  ]);
  const sections = parseContractMetaSections(wasm);
  assert.deepEqual(recordedToolchainPair(sections), {
    cliver: "27.0.0#93e1b1671f14830662766c005138b19095fe9307",
    rsver: "1.94.1",
  });
  assert.deepEqual(planMetadataReplay(sections)?.metadata_replay, ["bldopt=--locked"]);
});

test("recordedToolchainPair: no cliver-bearing section yields undefined, not a partial pair", () => {
  const wasm = makeWasm([[["rsver", "1.95.0"]]]);
  assert.equal(recordedToolchainPair(parseContractMetaSections(wasm)), undefined);
});

test("recordedToolchainPair: cliver present without rsver yields undefined", () => {
  const wasm = makeWasm([[["cliver", "25.1.0"]]]);
  assert.equal(recordedToolchainPair(parseContractMetaSections(wasm)), undefined);
});

test("recordedToolchainPair: duplicate cliver entries across sections fail closed", () => {
  const wasm = makeWasm([
    [
      ["cliver", "25.1.0"],
      ["rsver", "1.95.0"],
    ],
    [
      ["cliver", "26.0.0"],
      ["rsver", "1.94.1"],
    ],
  ]);
  assert.throws(
    () => recordedToolchainPair(parseContractMetaSections(wasm)),
    /Duplicate cliver entries across contractmetav0 sections/,
  );
});

test("recordedToolchainPair: duplicate cliver or rsver across all sections fails closed", () => {
  const duplicateCliver = makeWasm([
    [
      ["cliver", "25.1.0"],
      ["cliver", "25.2.0"],
      ["rsver", "1.95.0"],
    ],
  ]);
  assert.throws(
    () => recordedToolchainPair(parseContractMetaSections(duplicateCliver)),
    /Duplicate cliver entries/,
  );

  const duplicateRsver = makeWasm([
    [["rsver", "1.95.0"]],
    [
      ["cliver", "25.1.0"],
      ["rsver", "1.96.0"],
    ],
  ]);
  assert.throws(
    () => recordedToolchainPair(parseContractMetaSections(duplicateRsver)),
    /Duplicate rsver entries/,
  );
});

function makeWasm(sections: Array<Array<[string, string]>>): Uint8Array {
  const customSections = sections.map((entries) =>
    customSection("contractmetav0", concat(entries.map(([key, value]) => metaEntry({ key, value })))),
  );
  return concat([new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), ...customSections]);
}

function makeWasmFromPayload(payload: Uint8Array): Uint8Array {
  return concat([new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), customSection("contractmetav0", payload)]);
}

function customSection(name: string, payload: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const body = concat([uleb(nameBytes.length), nameBytes, payload]);
  return concat([new Uint8Array([0]), uleb(body.length), body]);
}

function metaEntry(entry: ContractMetaEntry): Uint8Array {
  return concat([writeU32(0), xdrString(entry.key), xdrString(entry.value)]);
}

function xdrString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const padding = new Uint8Array((4 - (bytes.length % 4)) % 4);
  return concat([writeU32(bytes.length), bytes, padding]);
}

function writeU32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function uleb(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return new Uint8Array(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
