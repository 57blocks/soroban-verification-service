import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

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

const subtleCryptoSha256 = async (file: File) => {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return bytesToHex(new Uint8Array(digest));
};

/** Hashed a slice at a time so a large archive is never materialised and the tab does not freeze. */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

const jsSha256 = async (file: File) => {
  const hash = sha256.create();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    const chunk = file.slice(offset, offset + HASH_CHUNK_BYTES);
    hash.update(new Uint8Array(await chunk.arrayBuffer()));
  }
  return bytesToHex(hash.digest());
};

export const fileToSha256 = async (file: File) =>
  crypto?.subtle ? subtleCryptoSha256(file) : jsSha256(file);
