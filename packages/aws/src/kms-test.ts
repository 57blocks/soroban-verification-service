import assert from "node:assert/strict";
import { test } from "node:test";
import { createKmsClient } from "./kms.js";

test("a KMS client retries throttling a bounded number of times and never waits on a hung request", async () => {
  const client = createKmsClient("ap-southeast-2");
  assert.equal(await client.config.maxAttempts(), 4);
  const handler = client.config.requestHandler as unknown as { configProvider: Promise<{ requestTimeout?: number; connectionTimeout?: number }> };
  const options = await handler.configProvider;
  assert.equal(options.requestTimeout, 5_000);
  assert.equal(options.connectionTimeout, 3_000);
});
