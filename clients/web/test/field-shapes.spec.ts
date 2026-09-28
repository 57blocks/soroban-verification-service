import { describe, expect, test } from "vitest";
import { SEP58_HEX_SHA256, SOURCE_URI_PATTERN as SDK_SOURCE_URI_PATTERN } from "soroban-verification-client";
import {
  CONTRACT_ID_SHAPE,
  HEX_SHA256_ANY_CASE,
  isHexSha256,
  SOURCE_URI_PATTERN,
} from "@/lib/field-shapes";
import { isContractId } from "@/features/aggregator/hooks/use-contract-lookup";

const LOWER = "a2e60e0fb85c39afa7930fc889cf55b93cfda930f16d2d419b4e18eeea7b4957";
const CONTRACT = `C${"A".repeat(55)}`;

describe("the SHA-256 shape", () => {
  test("is the server's shape — the same source, only the case flag added", () => {
    expect(HEX_SHA256_ANY_CASE.source).toBe(SEP58_HEX_SHA256.source);
    expect(HEX_SHA256_ANY_CASE.flags).toBe("i");
  });

  test("accepts everything the server accepts", () => {
    expect(SEP58_HEX_SHA256.test(LOWER)).toBe(true);
    expect(isHexSha256(LOWER)).toBe(true);
  });

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
    expect(CONTRACT_ID_SHAPE.test(`C${"A".repeat(54)}1`)).toBe(false);
  });

  test("the lookup page accepts lowercase, because it uppercases what it sends", () => {
    expect(isContractId(CONTRACT.toLowerCase())).toBe(true);
  });

  test("the bare shape — the submit form's rule — refuses lowercase, because that form sends it as typed", () => {
    expect(CONTRACT_ID_SHAPE.test(CONTRACT.toLowerCase())).toBe(false);
  });
});
