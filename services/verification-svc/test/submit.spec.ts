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
describe("POST /api/verification/v1/verifications validation", () => {
  // The row E2E-API-01 sends and this suite never did.
  it("rejects a body with no target at all", async () => {
    const res = await request(server).post("/api/verification/v1/verifications").send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "invalid_request",
      message: "target.network must be 'mainnet' or 'testnet'",
      status_code: 400,
    });
  });

  // The other half of the same hole: present, but nothing to descend into.
  it.each([
    ["a string", "testnet"],
    ["an array", []],
    ["null", null],
  ])("rejects a target that is %s", async (_name, target) => {
    const res = await request(server).post("/api/verification/v1/verifications").send({ target });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.status_code).toBe(400);
  });

  it("rejects a missing target.network", async () => {
    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .send({ target: { contract_id: "C123" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "invalid_request",
      message: "target.network must be 'mainnet' or 'testnet'",
      status_code: 400,
    });
  });

  it("rejects an invalid target.network value", async () => {
    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .send({ target: { network: "devnet", contract_id: "C123" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "invalid_request",
      message: "target.network must be 'mainnet' or 'testnet'",
      status_code: 400,
    });
  });

  it("rejects a target missing both contract_id and wasm_hash", async () => {
    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .send({ target: { network: "testnet" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "invalid_request",
      message: "target must include contract_id or wasm_hash",
      status_code: 400,
    });
  });
});
