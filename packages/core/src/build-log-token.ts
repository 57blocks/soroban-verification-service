import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Authorises reading one job's raw build log; returned once and stored only as a digest. */

const TOKEN_BYTES = 32;

/** base64url of TOKEN_BYTES, unpadded. */
const TOKEN_LENGTH = 43;

export function mintBuildLogToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashBuildLogToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isBuildLogTokenShaped(value: string): boolean {
  return value.length === TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

/** Compares digests, not tokens: both are 32 bytes, so the comparison cannot leak a length. */
export function buildLogTokenMatches(supplied: string, storedHash: string | undefined): boolean {
  if (!storedHash) return false;
  const expected = Buffer.from(storedHash, "hex");
  // timingSafeEqual throws on a length mismatch; a malformed stored value must return false.
  if (expected.length !== 32) return false;
  return timingSafeEqual(Buffer.from(hashBuildLogToken(supplied), "hex"), expected);
}
