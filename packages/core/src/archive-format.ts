export type ArchiveFormat = "gzip" | "zip" | "tar" | "unknown";

/** `ustar` occupies offsets 257-261; the zip and gzip magics are at 0. */
export const ARCHIVE_HEAD_BYTES = 262;

export function sniffArchiveFormatFromHead(head: Uint8Array): ArchiveFormat {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  // Local file header, empty archive and spanned archive: `PK` plus a two-byte kind.
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

export type UploadArchiveFormat = "gzip" | "zip";

export function uploadArchiveFormat(head: Uint8Array): UploadArchiveFormat | undefined {
  const format = sniffArchiveFormatFromHead(head);
  return format === "gzip" || format === "zip" ? format : undefined;
}

export const UPLOAD_ARCHIVE_CONTENT_TYPE: Record<UploadArchiveFormat, string> = {
  gzip: "application/gzip",
  zip: "application/zip",
};

export const UPLOAD_ARCHIVE_DEFAULT_SUFFIX: Record<UploadArchiveFormat, string> = {
  gzip: ".tar.gz",
  zip: ".zip",
};
