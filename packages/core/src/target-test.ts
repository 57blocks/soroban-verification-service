import assert from "node:assert/strict";
import { parseDto } from "./validate.js";
import { RegistryStatusObject, SEP58_HEX_SHA256 } from "./registry.js";
import { VerificationTarget } from "./target.js";

const UPPERCASE = "A2E60E0FB85C39AFA7930FC889CF55B93CFDA930F16D2D419B4E18EEEA7B4957";
const LOWERCASE = UPPERCASE.toLowerCase();

function main(): void {
  const upper = parseDto(VerificationTarget, { network: "testnet", wasm_hash: UPPERCASE });
  assert.equal(upper.wasm_hash, LOWERCASE, "an uppercase wasm_hash must normalise on parse");

  const mixed = parseDto(VerificationTarget, {
    network: "testnet",
    wasm_hash: `${UPPERCASE.slice(0, 32)}${LOWERCASE.slice(32)}`,
  });
  assert.equal(mixed.wasm_hash, LOWERCASE);

  assert.equal(parseDto(VerificationTarget, { network: "testnet", wasm_hash: LOWERCASE }).wasm_hash, LOWERCASE);
  assert.equal(parseDto(VerificationTarget, { network: "testnet", contract_id: "C" }).wasm_hash, undefined);

  const fromStoredRow = parseDto(VerificationTarget, JSON.parse(`{"network":"testnet","wasm_hash":"${UPPERCASE}"}`));
  assert.equal(fromStoredRow.wasm_hash, LOWERCASE);

  assert.equal(SEP58_HEX_SHA256.test(upper.wasm_hash as string), true);
  parseDto(RegistryStatusObject, {
    schema: "stellar-verification-status",
    schema_version: "1.0",
    wasm_hash: upper.wasm_hash,
    updated_at: "2026-08-19T01:56:51Z",
    source_code_verifications: [
      {
        verifier: { url: "https://v.example/public/", name: "scvs" },
        status: "verified",
        recipe_source: "on_chain_metadata",
        image_trust_level: "sdf_trusted",
        source_sha256: "b".repeat(64),
        processed_at: "2026-08-19T01:56:51Z",
      },
    ],
  });
  assert.throws(
    () =>
      parseDto(RegistryStatusObject, {
        schema: "stellar-verification-status",
        schema_version: "1.0",
        wasm_hash: UPPERCASE,
        updated_at: "2026-08-19T01:56:51Z",
        source_code_verifications: [
          {
        verifier: { url: "https://v.example/public/", name: "scvs" },
        status: "verified",
        recipe_source: "on_chain_metadata",
        image_trust_level: "sdf_trusted",
        source_sha256: "b".repeat(64),
        processed_at: "2026-08-19T01:56:51Z",
      },
        ],
      }),
    "the publish validator must still refuse uppercase — normalising is the boundary's job, not its own",
  );

  console.log("VerificationTarget wasm_hash: case normalised on parse, and agreed with the publish validator");
}

main();
