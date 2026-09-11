import { createHash } from "node:crypto";
import type { SourceReference } from "./source.js";

/**
 * SEP-58's own default for an absent `bldarg`. Normalising to it is what stops the same build, submitted two
 * ways, producing two keys and bypassing the dedup rules.
 */
const DEFAULT_BLDARG = ["contract", "build"] as const;

/** The identity of a *rebuild attempt*: `sha256(source_sha256 + bldimg + bldarg + bldopt)`. */
export function computeIdempotencyKey(
  sourceRef: SourceReference,
  imageDigest: string,
  buildOptions: unknown,
): string {
  const { bldarg, bldopt, metadataReplay } = readBuildOptions(buildOptions);
  const hash = createHash("sha256");
  hash.update(encodeString(sourceContentHash(sourceRef)));
  hash.update(encodeString(imageDigest));
  // `bldarg` is order-significant per SEP-58 and is hashed as received; `bldopt` is not, so it is sorted first
  // — without that, reordering two flags produces a second key and misses dedup.
  hash.update(encodeList(bldarg));
  hash.update(encodeList(sortBytewise(bldopt)));
  if (metadataReplay.length > 0) {
    hash.update(encodeList(metadataReplay));
  }
  return hash.digest("hex");
}

/** The hash of the *bytes* this source resolves to, for every arm. */
function sourceContentHash(source: SourceReference): string {
  switch (source.type) {
    case "git":
      if (!source.source_sha256) {
        throw new Error(
          "Cannot compute a rebuild key for a git source with no source_sha256: " +
            "{repo, rev} identifies a location, not the bytes it currently resolves to.",
        );
      }
      return source.source_sha256;
    case "hosted_tarball":
    case "private_tarball":
      return source.tarball_sha256;
    case "source_uri":
      return source.source_sha256;
  }
}

/** `<decimal byte length>:<UTF-8 bytes>`. */
function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from(`${bytes.length}:`, "ascii"), bytes]);
}

/** `<decimal element count>:<concatenated encodeString of each element>`. */
function encodeList(values: readonly string[]): Buffer {
  return Buffer.concat([
    Buffer.from(`${values.length}:`, "ascii"),
    ...values.map(encodeString),
  ]);
}

/** Bytewise, not `Array.prototype.sort()`'s default. */
function sortBytewise(values: readonly string[]): string[] {
  return [...values].sort((a, b) =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
  );
}

function readBuildOptions(buildOptions: unknown): {
  bldarg: readonly string[];
  bldopt: readonly string[];
  metadataReplay: readonly string[];
} {
  const value =
    buildOptions && typeof buildOptions === "object"
      ? (buildOptions as { bldarg?: unknown; bldopt?: unknown; metadata_replay?: unknown })
      : {};
  const bldarg = stringList(value.bldarg);
  return {
    bldarg: bldarg.length > 0 ? bldarg : DEFAULT_BLDARG,
    bldopt: stringList(value.bldopt),
    metadataReplay: stringList(value.metadata_replay),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}
