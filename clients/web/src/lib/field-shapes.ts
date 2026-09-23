import { SEP58_HEX_SHA256, SOURCE_URI_PATTERN } from "soroban-verification-client";

/**
 * The shapes the console checks a field against before it will send it, in one place.
 *
 * Every rule here that the server also enforces is **derived from the server's authority**, re-exported by
 * `soroban-verification-client`, rather than restated. The console carried its own copies — one of them
 * annotated "deliberately copied rather than imported" — only because it depends on the SDK and not on
 * `@scvs/core`; once the SDK exported the shapes there was no reason left to copy them.
 */

export { SOURCE_URI_PATTERN };

/**
 * A SHA-256 in **either** case. The server's `SEP58_HEX_SHA256` accepts lowercase only; the console accepts
 * both because a block explorer shows uppercase, and lowercases on the way out (`normalizeWasmHash`, and the
 * `source_sha256` line of `buildInlineManifest`). Built from the authority's `source`, so only the case
 * policy differs from it, and it differs here, on purpose, once.
 */
export const HEX_SHA256_ANY_CASE = new RegExp(SEP58_HEX_SHA256.source, "i");

/** Trimmed first: that is what every caller submits, and judging the untrimmed value would refuse valid input. */
export const isHexSha256 = (value: string): boolean => HEX_SHA256_ANY_CASE.test(value.trim());

/**
 * A Stellar contract address: `C` plus 55 base32 characters.
 *
 * Unlike the two above, this has **no server-side counterpart** to derive from — the submit API types
 * `contract_id` as a plain string, and only query-svc's resolver checks it (with a real `StrKey` checksum).
 * So this is the one copy, not a restatement. Case is the caller's decision, and the two callers make it
 * differently for a reason: the lookup page uppercases what it then *sends*; the submit form sends what was
 * typed, so it must refuse lowercase rather than pass it on to a CLI that will not resolve it.
 */
export const CONTRACT_ID_SHAPE = /^C[A-Z2-7]{55}$/;
