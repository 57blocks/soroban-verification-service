import assert from "node:assert/strict";
import { safeParseDto } from "@scvs/core";
import { TrustedVerifier } from "./shapes.js";

const BASE = {
  id: "scvs-example",
  display_name: "Example Verifier",
  status: "active" as const,
};

function main(): void {
  const valid = safeParseDto(TrustedVerifier, {
    ...BASE,
    url: "https://results.example.com",
    manifest_url: "https://results.example.com/verifier-manifest.json",
    bulk_load_url: "https://example.com/api/verification/v1/wasms",
  });
  assert.equal(valid.success, true, "an all-https entry must validate");

  for (const field of ["url", "manifest_url", "bulk_load_url"] as const) {
    const result = safeParseDto(TrustedVerifier, {
      ...BASE,
      url: "https://results.example.com",
      manifest_url: "https://results.example.com/verifier-manifest.json",
      bulk_load_url: "https://example.com/api/verification/v1/wasms",
      [field]: "http://results.example.com",
    });
    assert.equal(result.success, false, `${field} on http: must be rejected`);
  }

  const privateRangeLiteral = safeParseDto(TrustedVerifier, {
    ...BASE,
    url: "https://169.254.169.254",
    manifest_url: "https://results.example.com/verifier-manifest.json",
    bulk_load_url: "https://example.com/api/verification/v1/wasms",
  });
  assert.equal(
    privateRangeLiteral.success,
    true,
    "an https: IP literal is a scheme match at the DTO layer — checkUrl is what refuses the address itself",
  );

  console.log("trusted-verifier-url-test: ok");
}

main();
