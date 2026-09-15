import assert from "node:assert/strict";
import {
  FetchPolicyError,
  checkUrl,
  isBlockedIpLiteral,
  normalizePolicy,
  originsFromVerifiers,
} from "./fetch-policy.js";

// A standalone script rather than a Jest suite, following registry-test.ts's convention — no package under
// packages/* has a test runner configured.
//
// checkUrl/isBlockedIpLiteral were previously exercised only indirectly, through orchestrator-svc's
// policy-bound-fetch.spec.ts (pinningLookup/fetchThroughDestinationPolicy). Both scripts/seed-tvl.ts and
// clients/sdk's newClient() call checkUrl directly, so it needs its own coverage independent of that one
// caller.

function main(): void {
  const httpsOnly = normalizePolicy({ allowedSchemes: ["https:"] });

  assert.doesNotThrow(() => checkUrl(httpsOnly, "https://results.example.com/manifest.json"));
  assert.throws(() => checkUrl(httpsOnly, "http://results.example.com"), FetchPolicyError);
  assert.throws(() => checkUrl(httpsOnly, "not-a-url"), FetchPolicyError);

  // Private-range IP literals — the same ranges pinningLookup enforces post-resolution, checked here against
  // a URL's literal hostname (isBlockedIpLiteral does not, and cannot, see what a name resolves to).
  for (const host of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.5",
    "172.20.0.1",
    "169.254.169.254", // link-local, including cloud instance metadata
    "100.64.0.1", // carrier-grade NAT
    "localhost",
  ]) {
    assert.throws(
      () => checkUrl(normalizePolicy(), `https://${host}/x`),
      FetchPolicyError,
      `${host} must be refused`,
    );
  }
  // A public IP literal is legal — blockPrivateRanges only refuses the ranges above, not IP literals as such.
  assert.doesNotThrow(() => checkUrl(normalizePolicy(), "https://93.184.216.34/x"));

  // isBlockedIpLiteral does not evaluate a hostname that is not an IP literal: DNS-rebinding — a name
  // resolving into a private range at connect time — is checkUrl's blind spot by design, not a bug in it.
  // That gap is what pinningLookup (services/orchestrator-svc) exists to close post-resolution.
  assert.equal(isBlockedIpLiteral("attacker-controlled.example.com"), false);

  const origins = originsFromVerifiers([
    { url: "https://a.example.com/root", manifest_url: "https://a.example.com/m.json" },
    { url: "https://b.example.com", bulk_load_url: "https://api.b.example.com/wasms" },
    { url: "https://a.example.com/root2" }, // same origin as the first entry
  ]);
  assert.deepEqual(
    [...origins].sort(),
    ["https://a.example.com", "https://api.b.example.com", "https://b.example.com"].sort(),
  );

  // allowedOrigins enforcement: an origin not named by any TVL entry is refused even though its scheme and
  // host are otherwise unremarkable.
  const pinned = normalizePolicy({ allowedOrigins: ["https://a.example.com"] });
  assert.doesNotThrow(() => checkUrl(pinned, "https://a.example.com/anything"));
  assert.throws(() => checkUrl(pinned, "https://not-in-the-list.example.com/x"), FetchPolicyError);

  console.log("fetch-policy-test: ok");
}

main();
