import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
import express from "express";
import { IDENTITY_BODY_PARSERS, refuseEncodedRequestBodies } from "./identity-body.middleware.js";

const app = express();
app.use(refuseEncodedRequestBodies());
for (const [type, options] of IDENTITY_BODY_PARSERS) app.use(express[type](options));
app.post("/echo", (req, res) => {
  res.json({ received: req.body });
});

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function post(body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/echo`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  return { status: res.status, json: await res.json() };
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  console.log(`ok - ${name}`);
}

try {
  const payload = JSON.stringify({ hello: "world" });

  await test("a brotli body is refused before any parser reads it", async () => {
    const res = await post(new Uint8Array(brotliCompressSync(payload)), { "content-encoding": "br" });
    assert.equal(res.status, 415);
    assert.equal(res.json.error, "content_encoding_unsupported");
    assert.equal(res.json.status_code, 415);
  });

  await test("gzip and deflate are refused the same way", async () => {
    assert.equal((await post(new Uint8Array(gzipSync(payload)), { "content-encoding": "gzip" })).status, 415);
    assert.equal((await post(payload, { "content-encoding": "deflate" })).status, 415);
  });

  await test("a stacked encoding that starts with identity is still refused", async () => {
    assert.equal((await post(payload, { "content-encoding": "identity, br" })).status, 415);
  });

  await test("an unencoded body and an explicit identity encoding are parsed", async () => {
    assert.deepEqual((await post(payload, {})).json, { received: { hello: "world" } });
    assert.deepEqual((await post(payload, { "content-encoding": "Identity" })).json, { received: { hello: "world" } });
  });
} finally {
  server.close();
}
