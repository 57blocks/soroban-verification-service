/**
 * `uploadArchiveFormat` (`packages/core/src/archive-format.ts`) is the authority and is deliberately copied
 * rather than imported: the web bundle does not depend on `@scvs/core`.
 */

/** Enough for every marker below: `ustar` sits at offset 257, the other two at 0. */
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

/** Only the head is materialised; the archive itself may be 50 MB. */
export const readArchiveHead = async (file: File): Promise<Uint8Array> =>
  new Uint8Array(await file.slice(0, archiveHeadBytes).arrayBuffer());

/**
 * Why the picked bytes are not an archive this door admits, or `null`.
 *
 * Judged on the magic number and never on the name, because that is what `POST /v1/uploads/source` does —
 * a name rule here is strictly narrower than the endpoint it guards, and refuses uploads the API accepts
 * (`archive.tar(2).gz`, the name a browser gives a re-downloaded tarball).
 */
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

/** The code verification-svc answers with when the submitted archive is not the one the deployed Wasm records. */
export const sourceArchiveNotChainRecorded = "source_archive_not_chain_recorded";

/** Why a picked archive cannot be the chain's. */
export const chainSourceMismatchMessage = (chain: string, computed: string): string =>
  `The source archive you selected hashes to ${computed.toLowerCase()}, but this contract records ` +
  `source_sha256=${chain.toLowerCase()} on chain.`;

/** Returns the refusal, or `null` when there is nothing to refuse. */
export const chainSourceRefusal = (
  chainSourceSha256: string | undefined,
  computedSha256: string | undefined,
): string | null => {
  if (!chainSourceSha256 || !computedSha256) return null;
  if (chainSourceSha256.toLowerCase() === computedSha256.toLowerCase()) return null;
  return chainSourceMismatchMessage(chainSourceSha256, computedSha256);
};
