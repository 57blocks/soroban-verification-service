import { describe, expect, test } from "vitest";
import { SEP58_HEX_SHA256, SOURCE_URI_PATTERN as SDK_SOURCE_URI_PATTERN } from "soroban-verification-client";
import {
  CONTRACT_ID_SHAPE,
  HEX_SHA256_ANY_CASE,
  isHexSha256,
  SOURCE_URI_PATTERN,
} from "@/lib/field-shapes";
import { isContractId } from "@/features/aggregator/hooks/use-contract-lookup";

/**
 * The console used to carry its own copies of the server's field rules. These cases pin the property that
 * replaced them: the shapes are **derived from** the server's authority, so they cannot drift from it — and
 * the one place the console deliberately differs (case) is visible here rather than implied.
 */

const LOWER = "a2e60e0fb85c39afa7930fc889cf55b93cfda930f16d2d419b4e18eeea7b4957";
const CONTRACT = `C${"A".repeat(55)}`;

describe("the SHA-256 shape", () => {
  test("is the server's shape — the same source, only the case flag added", () => {
    expect(HEX_SHA256_ANY_CASE.source).toBe(SEP58_HEX_SHA256.source);
    expect(HEX_SHA256_ANY_CASE.flags).toBe("i");
  });

  // The direction that matters: the console must never refuse what the server would accept.
  test("accepts everything the server accepts", () => {
    expect(SEP58_HEX_SHA256.test(LOWER)).toBe(true);
    expect(isHexSha256(LOWER)).toBe(true);
  });

  // And the one deliberate difference: a block explorer shows uppercase, and the console lowercases on send.
  test("also accepts the uppercase a block explorer shows, which the server does not", () => {
    expect(SEP58_HEX_SHA256.test(LOWER.toUpperCase())).toBe(false);
    expect(isHexSha256(LOWER.toUpperCase())).toBe(true);
    expect(isHexSha256(`AB${LOWER.slice(2)}`)).toBe(true);
  });

  test("trims before judging, because the trimmed value is what gets submitted", () => {
    expect(isHexSha256(`  ${LOWER}\n`)).toBe(true);
  });

  test("refuses the wrong length and non-hex", () => {
    expect(isHexSha256(LOWER.slice(1))).toBe(false);
    expect(isHexSha256(`${LOWER}0`)).toBe(false);
    expect(isHexSha256(`g${LOWER.slice(1)}`)).toBe(false);
    expect(isHexSha256("")).toBe(false);
  });
});

describe("the source URI shape", () => {
  // Identity, not equality: the file that used to say "deliberately copied rather than imported" now imports.
  test("is the SDK's own object, not a copy of it", () => {
    expect(SOURCE_URI_PATTERN).toBe(SDK_SOURCE_URI_PATTERN);
  });
});

describe("the contract ID shape", () => {
  test("accepts a C-address of the right length", () => {
    expect(CONTRACT_ID_SHAPE.test(CONTRACT)).toBe(true);
  });

  test("refuses the wrong prefix, length or alphabet", () => {
    expect(CONTRACT_ID_SHAPE.test(`G${"A".repeat(55)}`)).toBe(false);
    expect(CONTRACT_ID_SHAPE.test(`C${"A".repeat(54)}`)).toBe(false);
    expect(CONTRACT_ID_SHAPE.test(`C${"A".repeat(56)}`)).toBe(false);
    // 0, 1, 8 and 9 are not in base32's alphabet.
    expect(CONTRACT_ID_SHAPE.test(`C${"A".repeat(54)}1`)).toBe(false);
  });

  /**
   * The two callers decide case differently, and both are right for what they send. The lookup page
   * uppercases and then sends the uppercased value. The submit form sends what was typed — `buildTarget` does
   * not normalise it — so it must refuse lowercase rather than pass it to a CLI that will not resolve it.
   * Pinned side by side so a later "just make them consistent" edit has to read why they are not.
   */
  test("the lookup page accepts lowercase, because it uppercases what it sends", () => {
    expect(isContractId(CONTRACT.toLowerCase())).toBe(true);
  });

  test("the bare shape — the submit form's rule — refuses lowercase, because that form sends it as typed", () => {
    expect(CONTRACT_ID_SHAPE.test(CONTRACT.toLowerCase())).toBe(false);
  });
});
