import assert from "node:assert/strict";
import {
  FetchPolicyError,
  checkUrl,
  isBlockedIpLiteral,
  normalizePolicy,
  originsFromVerifiers,
} from "./fetch-policy.js";

function main(): void {
  const httpsOnly = normalizePolicy({ allowedSchemes: ["https:"] });

  assert.doesNotThrow(() => checkUrl(httpsOnly, "https://results.example.com/manifest.json"));
  assert.throws(() => checkUrl(httpsOnly, "http://results.example.com"), FetchPolicyError);
  assert.throws(() => checkUrl(httpsOnly, "not-a-url"), FetchPolicyError);

  for (const host of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.5",
    "172.20.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "localhost",
  ]) {
    assert.throws(
      () => checkUrl(normalizePolicy(), `https://${host}/x`),
      FetchPolicyError,
      `${host} must be refused`,
    );
  }
  assert.doesNotThrow(() => checkUrl(normalizePolicy(), "https://93.184.216.34/x"));

  assert.equal(isBlockedIpLiteral("attacker-controlled.example.com"), false);

  const origins = originsFromVerifiers([
    { url: "https://a.example.com/root", manifest_url: "https://a.example.com/m.json" },
    { url: "https://b.example.com", bulk_load_url: "https://api.b.example.com/wasms" },
    { url: "https://a.example.com/root2" },
  ]);
  assert.deepEqual(
    [...origins].sort(),
    ["https://a.example.com", "https://api.b.example.com", "https://b.example.com"].sort(),
  );

  const pinned = normalizePolicy({ allowedOrigins: ["https://a.example.com"] });
  assert.doesNotThrow(() => checkUrl(pinned, "https://a.example.com/anything"));
  assert.throws(() => checkUrl(pinned, "https://not-in-the-list.example.com/x"), FetchPolicyError);

  console.log("fetch-policy-test: ok");
}

main();
