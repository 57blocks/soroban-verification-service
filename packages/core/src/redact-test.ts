import assert from "node:assert/strict";
import { redactAll, redactLocalPath, redactSecrets } from "./redact.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("drops a presigned URL's query string, keeps host and key", () => {
  const url =
    "https://example-staging-scratch.s3.ap-southeast-2.amazonaws.com/staging/r1/build/params/runner.json" +
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE123456789%2F20260822" +
    "&X-Amz-Security-Token=FwoGZXIvYXdzEDMaDF" +
    "&X-Amz-Signature=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  const redacted = redactSecrets(url);

  assert.ok(!redacted.includes("X-Amz-Signature"));
  assert.ok(!redacted.includes("X-Amz-Security-Token"));
  assert.ok(!redacted.includes("ASIAEXAMPLE123456789"));
  assert.ok(redacted.includes("example-staging-scratch.s3.ap-southeast-2.amazonaws.com"));
  assert.ok(redacted.includes("staging/r1/build/params/runner.json"));
});

test("redactAll layers URL/token redaction over local paths", () => {
  const redacted = redactAll(
    "fetched /tmp/scvs-artifacts/download-x/evil.tar from https://h@bucket/key?X-Amz-Signature=abc",
  );
  assert.ok(!redacted.includes("evil.tar"));
  assert.ok(!redacted.includes("X-Amz-Signature=abc"));
  assert.ok(redacted.includes("/tmp/<redacted>"));
});

test("redactLocalPath keeps the segment after a home directory", () => {
  assert.equal(redactLocalPath("/Users/alice/src/app"), "/Users/<redacted>/src/app");
});

test("keeps non-sensitive Rust toolchain diagnostics", () => {
  const marker = "RUSTUP_TOOLCHAIN=1.96.0-x86_64-unknown-linux-gnu rustc 1.96.0";
  assert.equal(redactAll(marker), marker);
});
