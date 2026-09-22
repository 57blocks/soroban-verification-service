import type {
  WasmComparisonDiagnostics as WasmComparisonDiagnosticsDto,
  WasmSummary as WasmSummaryDto,
} from "@scvs/core";

/**
 * **Why a mismatch happened** — a best-effort structural diff (sections, imports, exports, custom sections)
 * between the deployed Wasm and the one we rebuilt.
 */

/** The structural diff. */
export function describeWasmMismatch(
  deployed: Uint8Array | undefined,
  rebuilt: Uint8Array,
): WasmComparisonDiagnosticsDto {
  return compareWasmArtifacts(deployed, rebuilt);
}

/**
 * Human-readable troubleshooting hints for a mismatch. Always includes the standing caveats (diagnostics are
 * hints, not proof) plus anything the structural diff turned up.
 */
export function inferMismatchCauses(compare: WasmComparisonDiagnosticsDto): string[] {
  const causes = new Set<string>();
  causes.add("Verification still requires a byte-for-byte Wasm match; diagnostics are only troubleshooting hints.");
  causes.add("Check source revision and source archive bytes, especially if source_sha256 was created from a different tarball.");
  causes.add("Check build image digest, Stellar CLI version, Rust toolchain, Cargo.lock, feature flags, profile, and optimizer settings.");
  causes.add("Dependency acquisition is locked during vendoring; if dependencies differ, check Cargo.lock presence and contents.");

  const deployed = compare.deployed;
  const rebuilt = compare.rebuilt;
  if (deployed && rebuilt) {
    if ((deployed.imports || []).join("\n") !== (rebuilt.imports || []).join("\n")) {
      causes.add("Imports differ, which usually points to different source, dependencies, SDK version, or feature flags.");
    }
    if ((deployed.exports || []).join("\n") !== (rebuilt.exports || []).join("\n")) {
      causes.add("Exports differ, which usually points to a different contract package, source revision, or feature set.");
    }
    if (deployed.function_count !== rebuilt.function_count || deployed.code_count !== rebuilt.code_count) {
      causes.add("Function/code counts differ, which usually means the rebuilt contract logic is not the same binary input.");
    }
    if (compare.custom_section_diff?.only_deployed.length || compare.custom_section_diff?.only_rebuilt.length) {
      causes.add("Custom sections differ; check embedded metadata, contract spec generation, and build flags.");
    }
    if (deployed.size_bytes !== rebuilt.size_bytes && deployed.function_count === rebuilt.function_count) {
      causes.add("Wasm sizes differ while function counts are similar; optimizer, metadata, or toolchain settings may differ.");
    }
  }

  return [...causes];
}

function compareWasmArtifacts(
  deployedBytes: Uint8Array | undefined,
  rebuiltBytes: Uint8Array,
): WasmComparisonDiagnosticsDto {
  const parseErrors: NonNullable<WasmComparisonDiagnosticsDto["parse_errors"]> = {};
  let deployed: WasmSummaryDto | undefined;
  let rebuilt: WasmSummaryDto | undefined;

  if (!deployedBytes) {
    parseErrors.deployed = "The deployed Wasm was not available to diff against.";
  } else {
    try {
      deployed = parseWasmSummary(asBuffer(deployedBytes));
    } catch (error) {
      parseErrors.deployed = error instanceof Error ? error.message : String(error);
    }
  }

  try {
    rebuilt = parseWasmSummary(asBuffer(rebuiltBytes));
  } catch (error) {
    parseErrors.rebuilt = error instanceof Error ? error.message : String(error);
  }

  return {
    ...(deployed ? { deployed } : {}),
    ...(rebuilt ? { rebuilt } : {}),
    ...(deployed && rebuilt ? { section_diffs: compareSectionSizes(deployed, rebuilt) } : {}),
    ...(deployed && rebuilt ? { custom_section_diff: compareStringSets(deployed.custom_sections || [], rebuilt.custom_sections || []) } : {}),
    ...(deployed && rebuilt ? { import_diff: compareStringSets(deployed.imports || [], rebuilt.imports || []) } : {}),
    ...(deployed && rebuilt ? { export_diff: compareStringSets(deployed.exports || [], rebuilt.exports || []) } : {}),
    ...(Object.keys(parseErrors).length ? { parse_errors: parseErrors } : {}),
  };
}

/**
 * A `Buffer` view over the same memory — no copy. The parser below wants `readUInt32LE`/`subarray`, which are
 * `Buffer`'s and not `Uint8Array`'s, and these binaries are megabytes.
 */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function parseWasmSummary(bytes: Buffer): WasmSummaryDto {
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100 || bytes.readUInt32LE(4) !== 1) {
    throw new Error("Invalid or unsupported Wasm binary header.");
  }

  const reader = new WasmReader(bytes, 8);
  const sections: NonNullable<WasmSummaryDto["sections"]> = [];
  const customSections: string[] = [];
  const imports: string[] = [];
  const exports: string[] = [];
  let typeCount: number | undefined;
  let functionCount: number | undefined;
  let codeCount: number | undefined;

  while (!reader.done()) {
    const id = reader.u8();
    const size = reader.varuint32();
    const payloadStart = reader.offset;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > bytes.length) {
      throw new Error(`Wasm section ${id} exceeds file bounds.`);
    }
    const sectionReader = new WasmReader(bytes.subarray(payloadStart, payloadEnd));
    const section: NonNullable<WasmSummaryDto["sections"]>[number] = {
      id,
      name: wasmSectionName(id),
      size_bytes: size,
    };

    try {
      if (id === 0) {
        const customName = sectionReader.name();
        section.custom_name = customName;
        customSections.push(customName);
      } else if (id === 1) {
        typeCount = sectionReader.varuint32();
        section.count = typeCount;
      } else if (id === 2) {
        section.count = parseImportSection(sectionReader, imports);
      } else if (id === 3) {
        functionCount = sectionReader.varuint32();
        section.count = functionCount;
      } else if (id === 7) {
        section.count = parseExportSection(sectionReader, exports);
      } else if (id === 10) {
        codeCount = sectionReader.varuint32();
        section.count = codeCount;
      } else if ([4, 5, 6, 9, 11, 12].includes(id)) {
        section.count = sectionReader.varuint32();
      }
    } catch {
      // Keep section-level size diagnostics even when a sub-parser cannot understand a future Wasm encoding.
    }

    sections.push(section);
    reader.offset = payloadEnd;
  }

  return {
    size_bytes: bytes.length,
    section_count: sections.length,
    sections,
    custom_sections: customSections,
    soroban_custom_sections: customSections.filter((name) => /soroban|contract|stellar|meta|spec/i.test(name)),
    imports: imports.sort(),
    exports: exports.sort(),
    type_count: typeCount,
    function_count: functionCount,
    code_count: codeCount,
  };
}

function parseImportSection(reader: WasmReader, imports: string[]): number {
  const count = reader.varuint32();
  for (let index = 0; index < count; index += 1) {
    const moduleName = reader.name();
    const fieldName = reader.name();
    const kind = reader.u8();
    imports.push(`${moduleName}.${fieldName}:${externalKindName(kind)}`);
    skipImportDescriptor(reader, kind);
  }
  return count;
}

function parseExportSection(reader: WasmReader, exports: string[]): number {
  const count = reader.varuint32();
  for (let index = 0; index < count; index += 1) {
    const name = reader.name();
    const kind = reader.u8();
    const itemIndex = reader.varuint32();
    exports.push(`${name}:${externalKindName(kind)}#${itemIndex}`);
  }
  return count;
}

function skipImportDescriptor(reader: WasmReader, kind: number): void {
  if (kind === 0x00) {
    reader.varuint32();
    return;
  }
  if (kind === 0x01) {
    skipLimits(reader);
    return;
  }
  if (kind === 0x02) {
    skipLimits(reader);
    return;
  }
  if (kind === 0x03) {
    reader.u8();
    reader.u8();
  }
}

function skipLimits(reader: WasmReader): void {
  const flags = reader.u8();
  reader.varuint32();
  if (flags & 0x01) {
    reader.varuint32();
  }
}

function compareSectionSizes(deployed: WasmSummaryDto, rebuilt: WasmSummaryDto): NonNullable<WasmComparisonDiagnosticsDto["section_diffs"]> {
  const deployedSizes = sectionSizeMap(deployed);
  const rebuiltSizes = sectionSizeMap(rebuilt);
  const keys = new Set([...Object.keys(deployedSizes), ...Object.keys(rebuiltSizes)]);
  return [...keys]
    .sort()
    .filter((key) => deployedSizes[key] !== rebuiltSizes[key])
    .map((key) => ({
      key,
      ...(deployedSizes[key] !== undefined ? { deployed: deployedSizes[key] } : {}),
      ...(rebuiltSizes[key] !== undefined ? { rebuilt: rebuiltSizes[key] } : {}),
    }));
}

function sectionSizeMap(summary: WasmSummaryDto): Record<string, number> {
  const result: Record<string, number> = {};
  for (const section of summary.sections || []) {
    const key = section.custom_name ? `${section.name}:${section.custom_name}` : section.name;
    result[key] = (result[key] || 0) + section.size_bytes;
  }
  return result;
}

function compareStringSets(left: string[], right: string[]): { only_deployed: string[]; only_rebuilt: string[]; common: string[] } {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return {
    only_deployed: left.filter((value) => !rightSet.has(value)),
    only_rebuilt: right.filter((value) => !leftSet.has(value)),
    common: left.filter((value) => rightSet.has(value)),
  };
}

function wasmSectionName(id: number): string {
  const names: Record<number, string> = {
    0: "custom",
    1: "type",
    2: "import",
    3: "function",
    4: "table",
    5: "memory",
    6: "global",
    7: "export",
    8: "start",
    9: "element",
    10: "code",
    11: "data",
    12: "data_count",
  };
  return names[id] || `unknown_${id}`;
}

function externalKindName(kind: number): string {
  const names: Record<number, string> = {
    0x00: "func",
    0x01: "table",
    0x02: "mem",
    0x03: "global",
    0x04: "tag",
  };
  return names[kind] || `kind_${kind}`;
}

class WasmReader {
  offset: number;

  constructor(
    private readonly bytes: Buffer,
    offset = 0,
  ) {
    this.offset = offset;
  }

  done(): boolean {
    return this.offset >= this.bytes.length;
  }

  u8(): number {
    if (this.offset >= this.bytes.length) {
      throw new Error("Unexpected end of Wasm data.");
    }
    return this.bytes[this.offset++];
  }

  varuint32(): number {
    let result = 0;
    let shift = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result >>> 0;
      }
      shift += 7;
    }
    throw new Error("Invalid Wasm varuint32.");
  }

  name(): string {
    const length = this.varuint32();
    const end = this.offset + length;
    if (end > this.bytes.length) {
      throw new Error("Wasm name exceeds section bounds.");
    }
    const value = this.bytes.subarray(this.offset, end).toString("utf8");
    this.offset = end;
    return value;
  }
}
