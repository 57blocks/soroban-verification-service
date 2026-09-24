import type { Server } from "node:http";
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

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request(server).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
    expect(typeof res.body.version).toBe("string");
  });
});

describe("unknown route", () => {
  it("returns the shared 404 JSON shape", async () => {
    const res = await request(server).get("/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "not_found",
      message: "Endpoint not found",
      status_code: 404,
    });
  });
});
