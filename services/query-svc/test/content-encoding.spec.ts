import { brotliCompressSync } from "node:zlib";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";

let app: NestExpressApplication;

beforeAll(async () => {
  const { createTestApp } = await import("./bootstrap.js");
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe("encoded request bodies", () => {
  it("refuses a brotli body on any route before it is decoded", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/query/v1/results")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "br")
      .send(brotliCompressSync(JSON.stringify({ hello: "world" })));

    expect(res.status).toBe(415);
    expect(res.body.error).toBe("content_encoding_unsupported");
  });
});
