import type { RecordedToolchainPair } from "./build-environment.js";

export type ContractMetaEntry = {
  key: string;
  value: string;
};

export type ContractMetaSection = {
  index: number;
  /** Never sorted or de-duplicated. */
  entries: ContractMetaEntry[];
};

export type Sep58Metadata = {
  bldimg?: string;
  bldarg?: string[];
  bldopt?: string[];
  source_sha256?: string;
  source_uri?: string;
  raw_entries: ContractMetaEntry[];
};

export type MetadataReplayPlan = {
  section_index: number;
  metadata_replay: string[];
  dropped_keys: string[];
  sep58: Sep58Metadata;
};

export class WasmMetadataParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasmMetadataParseError";
  }
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;
const WASM_VERSION_1 = [0x01, 0x00, 0x00, 0x00] as const;
const CUSTOM_SECTION_ID = 0;
const CONTRACT_META_SECTION_NAME = "contractmetav0";
const SCMETA_V0_DISCRIMINANT = 0;
const REGENERATED_META_KEYS = new Set(["cliver", "rsver", "rssdkver"]);
const SINGLE_VALUE_DRIVER_KEYS = new Set(["bldimg", "source_uri", "source_sha256"]);

export function parseContractMetaSections(wasm: Uint8Array): ContractMetaSection[] {
  assertWasmHeader(wasm);
  let offset = 8;
  const sections: ContractMetaSection[] = [];
  let metaIndex = 0;

  while (offset < wasm.length) {
    const id = readByte(wasm, offset, "section id");
    offset += 1;
    const size = readUleb128(wasm, offset, "section size");
    offset = size.nextOffset;
    const sectionEnd = offset + size.value;
    if (sectionEnd > wasm.length) {
      throw new WasmMetadataParseError("Wasm section length exceeds module size.");
    }

    if (id === CUSTOM_SECTION_ID) {
      const nameLen = readUleb128(wasm, offset, "custom section name length");
      offset = nameLen.nextOffset;
      const nameEnd = offset + nameLen.value;
      if (nameEnd > sectionEnd) {
        throw new WasmMetadataParseError("Custom section name length exceeds section size.");
      }
      const name = decodeUtf8(wasm.subarray(offset, nameEnd), "custom section name");
      offset = nameEnd;
      const payload = wasm.subarray(offset, sectionEnd);
      if (name === CONTRACT_META_SECTION_NAME) {
        sections.push({ index: metaIndex, entries: parseMetaEntries(payload) });
        metaIndex += 1;
      }
    }

    offset = sectionEnd;
  }

  return sections;
}

export function planMetadataReplay(
  sections: ContractMetaSection[],
): MetadataReplayPlan | undefined {
  const cliverSections = sections.filter((section) =>
    section.entries.some((entry) => entry.key === "cliver"),
  );
  if (cliverSections.length === 0) {
    return undefined;
  }
  if (cliverSections.length > 1) {
    throw new WasmMetadataParseError(
      "Multiple contractmetav0 sections contain cliver; the CLI-injected section is ambiguous.",
    );
  }

  const chosen = cliverSections[0];
  const seenSingle = new Set<string>();
  const droppedKeys: string[] = [];
  const replayEntries: ContractMetaEntry[] = [];
  const bldarg: string[] = [];
  const bldopt: string[] = [];
  let bldimg: string | undefined;
  let sourceSha256: string | undefined;
  let sourceUri: string | undefined;

  for (const entry of chosen.entries) {
    if (SINGLE_VALUE_DRIVER_KEYS.has(entry.key)) {
      if (seenSingle.has(entry.key)) {
        throw new WasmMetadataParseError(
          `Duplicate ${entry.key} entries in the CLI-injected contractmetav0 section.`,
        );
      }
      seenSingle.add(entry.key);
    }

    switch (entry.key) {
      case "bldimg":
        bldimg = entry.value;
        break;
      case "bldarg":
        bldarg.push(entry.value);
        break;
      case "bldopt":
        bldopt.push(entry.value);
        break;
      case "source_sha256":
        sourceSha256 = entry.value;
        break;
      case "source_uri":
        sourceUri = entry.value;
        break;
    }

    if (REGENERATED_META_KEYS.has(entry.key)) {
      droppedKeys.push(entry.key);
      continue;
    }
    replayEntries.push(entry);
  }

  return {
    section_index: chosen.index,
    metadata_replay: replayEntries.map((entry) => `${entry.key}=${entry.value}`),
    dropped_keys: droppedKeys,
    sep58: {
      ...(bldimg ? { bldimg } : {}),
      ...(bldarg.length ? { bldarg } : {}),
      ...(bldopt.length ? { bldopt } : {}),
      ...(sourceSha256 ? { source_sha256: sourceSha256 } : {}),
      ...(sourceUri ? { source_uri: sourceUri } : {}),
      raw_entries: chosen.entries,
    },
  };
}

/** Searches every section: cliver and rsver usually sit in separate `contractmetav0` sections. */
export function recordedToolchainPair(
  sections: ContractMetaSection[],
): RecordedToolchainPair | undefined {
  let cliver: string | undefined;
  let rsver: string | undefined;

  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.key === "cliver") {
        if (cliver !== undefined) {
          throw new WasmMetadataParseError(
            "Duplicate cliver entries across contractmetav0 sections.",
          );
        }
        cliver = entry.value;
      } else if (entry.key === "rsver") {
        if (rsver !== undefined) {
          throw new WasmMetadataParseError(
            "Duplicate rsver entries across contractmetav0 sections.",
          );
        }
        rsver = entry.value;
      }
    }
  }

  if (cliver === undefined || rsver === undefined) {
    return undefined;
  }

  return { cliver, rsver };
}

function parseMetaEntries(payload: Uint8Array): ContractMetaEntry[] {
  const entries: ContractMetaEntry[] = [];
  let offset = 0;

  while (offset < payload.length) {
    const discriminant = readXdrU32(payload, offset, "SCMetaEntry discriminant");
    offset += 4;
    if (discriminant !== SCMETA_V0_DISCRIMINANT) {
      throw new WasmMetadataParseError(
        `Unsupported SCMetaEntry discriminant ${discriminant}; only ScMetaV0 is supported.`,
      );
    }
    const key = readXdrString(payload, offset, "SCMetaV0 key");
    offset = key.nextOffset;
    const value = readXdrString(payload, offset, "SCMetaV0 value");
    offset = value.nextOffset;
    entries.push({ key: key.value, value: value.value });
  }

  return entries;
}

function assertWasmHeader(wasm: Uint8Array): void {
  if (wasm.length < 8) {
    throw new WasmMetadataParseError("Wasm module is too short.");
  }
  for (let index = 0; index < WASM_MAGIC.length; index += 1) {
    if (wasm[index] !== WASM_MAGIC[index]) {
      throw new WasmMetadataParseError("Invalid Wasm magic header.");
    }
  }
  for (let index = 0; index < WASM_VERSION_1.length; index += 1) {
    if (wasm[index + 4] !== WASM_VERSION_1[index]) {
      throw new WasmMetadataParseError("Unsupported Wasm version.");
    }
  }
}

function readByte(bytes: Uint8Array, offset: number, label: string): number {
  if (offset >= bytes.length) {
    throw new WasmMetadataParseError(`Unexpected end of input while reading ${label}.`);
  }
  return bytes[offset];
}

function readUleb128(
  bytes: Uint8Array,
  offset: number,
  label: string,
): { value: number; nextOffset: number } {
  let result = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    cursor += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(result)) {
        throw new WasmMetadataParseError(`${label} exceeds JavaScript's safe integer range.`);
      }
      return { value: result, nextOffset: cursor };
    }
    shift += 7;
    if (shift > 35) {
      throw new WasmMetadataParseError(`Malformed unsigned LEB128 while reading ${label}.`);
    }
  }

  throw new WasmMetadataParseError(`Truncated unsigned LEB128 while reading ${label}.`);
}

function readXdrU32(bytes: Uint8Array, offset: number, label: string): number {
  if (offset + 4 > bytes.length) {
    throw new WasmMetadataParseError(`Unexpected end of input while reading ${label}.`);
  }
  return (
    bytes[offset] * 2 ** 24 +
    bytes[offset + 1] * 2 ** 16 +
    bytes[offset + 2] * 2 ** 8 +
    bytes[offset + 3]
  );
}

function readXdrString(
  bytes: Uint8Array,
  offset: number,
  label: string,
): { value: string; nextOffset: number } {
  const length = readXdrU32(bytes, offset, `${label} length`);
  const start = offset + 4;
  const end = start + length;
  if (end > bytes.length) {
    throw new WasmMetadataParseError(`Unexpected end of input while reading ${label}.`);
  }
  const padding = (4 - (length % 4)) % 4;
  const nextOffset = end + padding;
  if (nextOffset > bytes.length) {
    throw new WasmMetadataParseError(`Unexpected end of input while reading ${label} padding.`);
  }
  return {
    value: decodeUtf8(bytes.subarray(start, end), label),
    nextOffset,
  };
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WasmMetadataParseError(
      `Invalid UTF-8 while reading ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
