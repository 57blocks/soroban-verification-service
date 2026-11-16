import type { Server } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTestApp } from "./bootstrap.js";

let app: NestExpressApplication;
let server: Server;
beforeAll(async () => {
  app = await createTestApp();
  server = app.getHttpServer();
});

afterAll(async () => {
  await app?.close();
});

describe("encoded request bodies", () => {
  it("refuses a brotli submission body before it is decoded", async () => {
    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "br")
      .send(brotliCompressSync(JSON.stringify({ target: { network: "testnet" } })));

    expect(res.status).toBe(415);
    expect(res.body.error).toBe("content_encoding_unsupported");
  });

  it("refuses an encoded body on the upload route too", async () => {
    const res = await request(server)
      .post("/api/verification/v1/uploads/source")
      .set("Content-Type", "application/gzip")
      .set("Content-Encoding", "gzip")
      .send(gzipSync(Buffer.from("not an archive")));

    expect(res.status).toBe(415);
    expect(res.body.error).toBe("content_encoding_unsupported");
  });

  it("still parses an unencoded JSON body", async () => {
    const res = await request(server).post("/api/verification/v1/verifications").send({});

    expect(res.status).not.toBe(415);
    expect(res.body.error).not.toBe("content_encoding_unsupported");
  });
});
