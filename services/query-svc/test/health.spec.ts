import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTestApp } from "./bootstrap.js";

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });
});

describe("unknown route", () => {
  it("returns the shared 404 JSON shape", async () => {
    const res = await request(app.getHttpServer()).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "not_found",
      message: "No such route.",
      status_code: 404,
    });
  });
});
