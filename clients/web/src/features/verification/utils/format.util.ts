import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/** Renders any JSON value the API can put in a result field as a single line of text. */
export const formatValue = (value: unknown) => {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

/** The width `HashCompare` sets each chunk to, and what a digest is split on for it. */
const HASH_CHUNK_CHARS = 8;

/**
 * Splits a hex digest for the chunk-by-chunk comparison. Returns `null` for anything that is not a digest, so a
 * caller renders nothing rather than a comparison of malformed strings.
 */
export const hashChunks = (hash: unknown): string[] | null => {
  if (typeof hash !== "string" || !/^[a-fA-F0-9]{64}$/.test(hash)) return null;
  const chunks: string[] = [];
  // Hex case is not significant, and two digests that differ only in it are the same digest.
  for (let at = 0; at < hash.length; at += HASH_CHUNK_CHARS) {
    chunks.push(hash.slice(at, at + HASH_CHUNK_CHARS).toLowerCase());
  }
  return chunks;
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
