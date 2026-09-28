import { createHash } from "node:crypto";
import type { SourceReference } from "./source.js";

const DEFAULT_BLDARG = ["contract", "build"] as const;

export function computeIdempotencyKey(
  sourceRef: SourceReference,
  imageDigest: string,
  buildOptions: unknown,
): string {
  const { bldarg, bldopt, metadataReplay } = readBuildOptions(buildOptions);
  const hash = createHash("sha256");
  hash.update(encodeString(sourceContentHash(sourceRef)));
  hash.update(encodeString(imageDigest));
  // `bldarg` order is significant; `bldopt` order is not, so only it is sorted.
  hash.update(encodeList(bldarg));
  hash.update(encodeList(sortBytewise(bldopt)));
  if (metadataReplay.length > 0) {
    hash.update(encodeList(metadataReplay));
  }
  return hash.digest("hex");
}

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

function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from(`${bytes.length}:`, "ascii"), bytes]);
}

function encodeList(values: readonly string[]): Buffer {
  return Buffer.concat([
    Buffer.from(`${values.length}:`, "ascii"),
    ...values.map(encodeString),
  ]);
}

/** Bytewise UTF-8 order, not `sort()`'s UTF-16 order; they differ above U+FFFF. */
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
