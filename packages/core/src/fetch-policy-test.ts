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
    "0.0.0.0",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "localhost",
  ]) {
    assert.throws(
      () => checkUrl(normalizePolicy(), `https://${host}/x`),
      FetchPolicyError,
      `${host} must be refused`,
    );
  }
  for (const host of ["93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "198.17.0.1", "198.20.0.1", "223.255.255.255"]) {
    assert.doesNotThrow(() => checkUrl(normalizePolicy(), `https://${host}/x`), `${host} must be allowed`);
  }
  assert.equal(isBlockedIpLiteral("999.1.1.1"), true);

  assert.equal(isBlockedIpLiteral("attacker-controlled.example.com"), false);

  // IPv6: URL literals (which WHATWG URL rewrites to hex) and resolved addresses take the same check.
  for (const host of [
    "[::]",
    "[::1]",
    "[0:0:0:0:0:0:0:1]",
    "[fe80::1]",
    "[fd00::1]",
    "[::ffff:10.0.0.1]",
    "[::ffff:169.254.169.254]",
    "[::ffff:93.184.216.34]",
    "[::169.254.169.254]",
    "[::a9fe:a9fe]",
    "[0:0:0:0:0:0:a9fe:a9fe]",
    "[::5db8:d822]",
  ]) {
    assert.throws(
      () => checkUrl(normalizePolicy(), `https://${host}/x`),
      FetchPolicyError,
      `${host} must be refused`,
    );
  }
  for (const address of [
    "::a9fe:a9fe",
    "::ffff:a00:1",
    "::169.254.169.254",
    "fe80::1%eth0",
    "1::2::3",
    "::g",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::a00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::10.0.0.1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:1ff::1",
    "2001:db8::1",
    "2002:a9fe:a9fe::1",
    "fec0::1",
    "ff02::1",
  ]) {
    assert.equal(isBlockedIpLiteral(address), true, `${address} must be refused`);
  }
  for (const address of [
    "2606:2800:220:1:248:1893:25c8:1946",
    "::1:0:0:0",
    "64::1",
    "64:ff9b:2::1",
    // What DNS64 adds next to a public A record: judged as the IPv4 address it reaches.
    "64:ff9b::8c52:7003",
    "64:ff9b::140.82.112.3",
    "100:0:0:1::1",
    "2001:200::1",
    "2001:4860:4860::8888",
    "2003::1",
    "fe00::1",
  ]) {
    assert.equal(isBlockedIpLiteral(address), false, `${address} must be allowed`);
  }
  assert.doesNotThrow(() => checkUrl(normalizePolicy(), "https://[2606:2800:220:1:248:1893:25c8:1946]/x"));

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
