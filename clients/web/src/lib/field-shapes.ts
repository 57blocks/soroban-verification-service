import { SEP58_HEX_SHA256, SOURCE_URI_PATTERN } from "soroban-verification-client";

export { SOURCE_URI_PATTERN };

/** Either case, unlike `SEP58_HEX_SHA256`; callers lowercase on the way out. */
export const HEX_SHA256_ANY_CASE = new RegExp(SEP58_HEX_SHA256.source, "i");

export const isHexSha256 = (value: string): boolean => HEX_SHA256_ANY_CASE.test(value.trim());

/** A Stellar contract address: `C` plus 55 base32 characters. */
export const CONTRACT_ID_SHAPE = /^C[A-Z2-7]{55}$/;
