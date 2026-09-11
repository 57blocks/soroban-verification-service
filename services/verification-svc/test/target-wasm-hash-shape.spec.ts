import { safeParseDto } from "@scvs/core";
import { PreflightRequestDto, mapPreflightIssues } from "../src/modules/preflight/preflight.dto.js";
import { SubmitTargetDto, mapSubmitIssues } from "../src/modules/verifications/submit.dto.js";

/**
 * `target.wasm_hash` at the submit and preflight boundaries — normalised to lowercase, and refused outright
 * when it is not a 64-character hex digest.
 */
const UPPERCASE = "A2E60E0FB85C39AFA7930FC889CF55B93CFDA930F16D2D419B4E18EEEA7B4957";
const LOWERCASE = UPPERCASE.toLowerCase();

const parseTarget = (wasm_hash: unknown) =>
  safeParseDto(SubmitTargetDto, { network: "testnet", ...(wasm_hash === undefined ? {} : { wasm_hash }) });

const rejectionMessage = (wasm_hash: unknown): string => {
  const result = parseTarget(wasm_hash);
  if (result.success) throw new Error(`expected ${JSON.stringify(wasm_hash)} to be rejected`);
  return mapSubmitIssues(result.errors).message;
};

describe("target.wasm_hash at the submit boundary", () => {
  it("accepts the incident's own uppercase input and normalises it", () => {
    const result = parseTarget(UPPERCASE);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.wasm_hash).toBe(LOWERCASE);
  });

  it("normalises a mixed-case paste too", () => {
    const result = parseTarget(`${UPPERCASE.slice(0, 32)}${LOWERCASE.slice(32)}`);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.wasm_hash).toBe(LOWERCASE);
  });

  it("leaves an already-lowercase hash alone", () => {
    const result = parseTarget(LOWERCASE);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.wasm_hash).toBe(LOWERCASE);
  });

  it("still accepts a contract_id-only target — the hash is optional and must stay so", () => {
    const result = safeParseDto(SubmitTargetDto, {
      network: "testnet",
      contract_id: "CABCDEF",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.wasm_hash).toBeUndefined();
  });

  it("refuses a hash that is the wrong length, naming the field", () => {
    expect(rejectionMessage(LOWERCASE.slice(0, 63))).toBe(
      "target.wasm_hash must be a 64-character hex Wasm hash",
    );
  });

  it("refuses a non-hex hash of the right length", () => {
    expect(rejectionMessage(`${"z".repeat(2)}${LOWERCASE.slice(2)}`)).toBe(
      "target.wasm_hash must be a 64-character hex Wasm hash",
    );
  });

  it("refuses a `0x`-prefixed hash — 66 characters, and a real paste shape", () => {
    expect(rejectionMessage(`0x${LOWERCASE}`)).toBe(
      "target.wasm_hash must be a 64-character hex Wasm hash",
    );
  });
});

describe("target.wasm_hash at the preflight boundary", () => {
  it("normalises the same way — preflight and submit must not disagree about a target", () => {
    const result = safeParseDto(PreflightRequestDto, { network: "testnet", wasm_hash: UPPERCASE });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.wasm_hash).toBe(LOWERCASE);
  });

  it("refuses a malformed hash with the same message", () => {
    const result = safeParseDto(PreflightRequestDto, { network: "testnet", wasm_hash: "not-a-hash" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(mapPreflightIssues(result.errors).message).toBe(
      "target.wasm_hash must be a 64-character hex Wasm hash",
    );
  });
});
