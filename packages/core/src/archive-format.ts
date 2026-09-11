// Which container format a run of bytes is, decided from its magic number.

/**
 * `tar` is a bare, uncompressed tar: a real archive the build path extracts, and one `stellar contract verify`
 * has no accepted filename for.
 */
export type ArchiveFormat = "gzip" | "zip" | "tar" | "unknown";

/** Enough for every marker below: `ustar` sits at offset 257, the other two at 0. */
export const ARCHIVE_HEAD_BYTES = 262;

export function sniffArchiveFormatFromHead(head: Uint8Array): ArchiveFormat {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  // Local file header, empty archive, and spanned archive — all three are `PK` plus a two-byte kind.
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) {
    const kind = (head[2] << 8) | head[3];
    if (kind === 0x0304 || kind === 0x0506 || kind === 0x0708) return "zip";
  }
  if (head.length >= ARCHIVE_HEAD_BYTES && latin1(head.subarray(257, 262)) === "ustar") return "tar";
  return "unknown";
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** What `POST /v1/uploads/source` admits, and it is narrower than what the build path can *read*. */
export type UploadArchiveFormat = "gzip" | "zip";

/** The format, or `undefined` for a body this door does not admit. From the bytes, never the filename. */
export function uploadArchiveFormat(head: Uint8Array): UploadArchiveFormat | undefined {
  const format = sniffArchiveFormatFromHead(head);
  return format === "gzip" || format === "zip" ? format : undefined;
}

/** What the staged object is stored as. S3 has no way to record "we did not look". */
export const UPLOAD_ARCHIVE_CONTENT_TYPE: Record<UploadArchiveFormat, string> = {
  gzip: "application/gzip",
  zip: "application/zip",
};

/** The suffix a stored object gets when `x-filename` gave us nothing usable. */
export const UPLOAD_ARCHIVE_DEFAULT_SUFFIX: Record<UploadArchiveFormat, string> = {
  gzip: ".tar.gz",
  zip: ".zip",
};
