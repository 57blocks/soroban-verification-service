/** `ustar` sits at offset 257; the gzip and zip markers at 0. */
export const archiveHeadBytes = 262;

export type PickedArchiveFormat = "gzip" | "zip" | "tar" | "unknown";

export const sniffArchiveFormat = (head: Uint8Array): PickedArchiveFormat => {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  // Local file header, empty archive, and spanned archive — all three are `PK` plus a two-byte kind.
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) {
    const kind = (head[2] << 8) | head[3];
    if (kind === 0x0304 || kind === 0x0506 || kind === 0x0708) return "zip";
  }
  if (head.length >= archiveHeadBytes && latin1(head.subarray(257, 262)) === "ustar") return "tar";
  return "unknown";
};

const latin1 = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
};

export const readArchiveHead = async (file: File): Promise<Uint8Array> =>
  new Uint8Array(await file.slice(0, archiveHeadBytes).arrayBuffer());

export const archiveFormatRefusal = (head: Uint8Array): string | null => {
  switch (sniffArchiveFormat(head)) {
    case "gzip":
    case "zip":
      return null;
    case "tar":
      return "This is an uncompressed tar. Compress it — `gzip archive.tar` — and select the result.";
    default:
      return "This file is not a gzip-compressed tarball or a zip. The archive is read by its bytes, not its name.";
  }
};

export const sourceArchiveNotChainRecorded = "source_archive_not_chain_recorded";

export const chainSourceMismatchMessage = (chain: string, computed: string): string =>
  `The source archive you selected hashes to ${computed.toLowerCase()}, but this contract records ` +
  `source_sha256=${chain.toLowerCase()} on chain.`;

export const chainSourceRefusal = (
  chainSourceSha256: string | undefined,
  computedSha256: string | undefined,
): string | null => {
  if (!chainSourceSha256 || !computedSha256) return null;
  if (chainSourceSha256.toLowerCase() === computedSha256.toLowerCase()) return null;
  return chainSourceMismatchMessage(chainSourceSha256, computedSha256);
};
