import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The secret that authorises reading one job's raw build log (build-log-access design.md BL-1). Minted at
 * submission, returned once, and stored only as a digest — the job id, which is the URL a submitter shares,
 * must not authorise the log.
 */

/** 256 bits, base64url so it survives a header, a shell and a copy-paste without escaping. */
const TOKEN_BYTES = 32;

/** The base64url encoding of TOKEN_BYTES: 43 characters, unpadded. */
const TOKEN_LENGTH = 43;

export function mintBuildLogToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashBuildLogToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Cheap shape check, so a header of arbitrary size never reaches a hash. */
export function isBuildLogTokenShaped(value: string): boolean {
  return value.length === TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Constant-time over the DIGESTS, not the tokens: both are 32 bytes by construction, so the comparison
 * cannot leak a length, and a supplied token of any shape costs the same.
 */
export function buildLogTokenMatches(supplied: string, storedHash: string | undefined): boolean {
  if (!storedHash) return false;
  const expected = Buffer.from(storedHash, "hex");
  // A stored value that is not a sha256 digest matches nothing, and must not throw.
  if (expected.length !== 32) return false;
  return timingSafeEqual(Buffer.from(hashBuildLogToken(supplied), "hex"), expected);
}
