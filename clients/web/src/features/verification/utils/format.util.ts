import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/** Renders any JSON value the API can put in a result field as a single line of text. */
export const formatValue = (value: unknown) => {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/** One shot over the whole archive — the native digest, used whenever the page can reach it. */
const subtleCryptoSha256 = async (file: File) => {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return bytesToHex(new Uint8Array(digest));
};

/**
 * Reads the archive a slice at a time rather than materialising all of it: the service accepts up to
 * `SCVS_MAX_SOURCE_ARCHIVE_BYTES` (50 MB by default), and `await chunk.arrayBuffer()` hands the event loop back
 * between slices, so hashing one of those in JS does not freeze the tab.
 */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

const jsSha256 = async (file: File) => {
  const hash = sha256.create();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    const chunk = file.slice(offset, offset + HASH_CHUNK_BYTES);
    hash.update(new Uint8Array(await chunk.arrayBuffer()));
  }
  return bytesToHex(hash.digest());
};

/** Hashes the picked archive in the browser so the submission commits to the exact bytes. */
export const fileToSha256 = async (file: File) =>
  crypto?.subtle ? subtleCryptoSha256(file) : jsSha256(file);
