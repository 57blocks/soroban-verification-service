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

// Characterization tests pinning the error envelope every route answers in — the version field included, since
// a consumer keys off it to know how to read the rest.
describe("POST /api/verification/v1/preflight validation", () => {
  it("rejects a missing network", async () => {
    const res = await request(server).post("/api/verification/v1/preflight").send({ contract_id: "C123" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "invalid_network",
      message: "network must be 'mainnet' or 'testnet'",
      status_code: 400,
    });
  });

  it("rejects an invalid network value", async () => {
    const res = await request(server)
      .post("/api/verification/v1/preflight")
      .send({ network: "devnet", contract_id: "C123" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "invalid_network",
      message: "network must be 'mainnet' or 'testnet'",
      status_code: 400,
    });
  });

  it("rejects a request missing both contract_id and wasm_hash", async () => {
    const res = await request(server).post("/api/verification/v1/preflight").send({ network: "testnet" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "missing_target",
      message: "Either contract_id or wasm_hash is required",
      status_code: 400,
    });
  });
});
