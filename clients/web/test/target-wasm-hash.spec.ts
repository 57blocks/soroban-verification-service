import { describe, expect, test } from "vitest";
import { buildTarget, normalizeWasmHash } from "@/features/verification/utils/manifest.util";
import type { VerifyFormValues } from "@/features/verification/types";

/**
 * The console is the shortest path to an uppercase `wasm_hash`: `TargetCard`'s field rule accepts either
 * case deliberately (`HEX_SHA256_ANY_CASE` in `src/lib/field-shapes.ts`).
 */
const UPPERCASE = "A2E60E0FB85C39AFA7930FC889CF55B93CFDA930F16D2D419B4E18EEEA7B4957";
const LOWERCASE = UPPERCASE.toLowerCase();

const values = (over: Partial<VerifyFormValues>) =>
  ({ network: "testnet", targetType: "wasm_hash", ...over }) as VerifyFormValues;

describe("the target a submission carries", () => {
  test("an uppercase paste reaches the request body lowercased", () => {
    expect(buildTarget(values({ wasmHash: UPPERCASE })).wasm_hash).toBe(LOWERCASE);
  });

  test("surrounding whitespace is still trimmed", () => {
    expect(normalizeWasmHash(`  ${UPPERCASE}\n`)).toBe(LOWERCASE);
  });

  test("an absent hash stays absent rather than becoming an empty string", () => {
    expect(normalizeWasmHash(undefined)).toBeUndefined();
    expect(buildTarget(values({ targetType: "contract_id", contractId: "CABC" })).wasm_hash).toBeUndefined();
  });

  test("a contract ID keeps its case — Stellar's own encoding is uppercase", () => {
    expect(buildTarget(values({ targetType: "contract_id", contractId: "CABCDEF" })).contract_id).toBe("CABCDEF");
  });
});
