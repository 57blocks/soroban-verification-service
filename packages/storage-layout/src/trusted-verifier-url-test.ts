import assert from "node:assert/strict";
import { safeParseDto } from "@scvs/core";
import { TrustedVerifier } from "./shapes.js";

// Plain-script test, following registry-status-test.ts's convention — packages/* has no Jest config anywhere
// in this repo.
//
// A TVL entry's url/manifest_url/bulk_load_url become query-svc's outbound fetch origins the moment this
// document is seeded (originsFromVerifiers), so the producer DTO holds them to the same https:-only standard
// SCVS_TRUSTED_VERIFIERS_SOURCE already gets — see fetch-policy.ts's checkUrl.

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
      [field]: "http://results.example.com", // downgraded to http:
    });
    assert.equal(result.success, false, `${field} on http: must be rejected`);
  }

  // The DTO's job is the scheme; the private-range/DNS-rebinding check is `checkUrl`'s at request time, not
  // this document's — a public https: hostname that a lookup could later resolve into a private range is
  // legal here on purpose.
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
