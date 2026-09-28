import type { Server } from "node:http";
import request from "supertest";
import { DrainState } from "@scvs/core";
import { bootstrap } from "../src/main.js";
import type { NestExpressApplication } from "@nestjs/platform-express";

let app: NestExpressApplication;
let server: Server;
let drain: DrainState;

beforeAll(async () => {
  app = await bootstrap();
  server = app.getHttpServer();
  drain = app.get(DrainState);
});

afterAll(async () => {
  await app.close();
});

describe("before a drain", () => {
  it("is ready, and says nothing is draining", async () => {
    const res = await request(server).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ready: true, draining: false });
    expect(res.body.checks.database.ok).toBe(true);
    expect("draining_since" in res.body).toBe(false);
  });

  it("liveness checks no dependencies", async () => {
    const res = await request(server).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "alive" });
  });
});

describe("while draining", () => {
  beforeAll(() => {
    drain.beginDrain(new Date().toISOString());
  });

  it("readiness turns false with 503, and says since when", async () => {
    const res = await request(server).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.draining).toBe(true);
    expect(typeof res.body.draining_since).toBe("string");
    expect(res.body.checks.database.ok).toBe(true);
  });

  it("liveness stays 200 — a drain must not get the task restarted", async () => {
    const res = await request(server).get("/health/live");
    expect(res.status).toBe(200);
  });

  it("`/health` is unchanged, because the deployment reads it", async () => {
    const res = await request(server).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });

  it("refuses a submission with 503 and a named reason", async () => {
    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .send({ target: { network: "testnet", contract_id: "C".repeat(56) } });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "draining", status_code: 503 });
    expect(res.body.message).toMatch(/status remains readable/);
  });

  it("refuses an upload with 503", async () => {
    const res = await request(server)
      .post("/api/verification/v1/uploads/source")
      .set("content-type", "application/gzip")
      .send(Buffer.from("not really a tarball"));

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "draining" });
  });

  it("★ still serves job status — the reason the guard is not global", async () => {
    const res = await request(server).get("/api/verification/v1/verifications/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("still serves preflight — it creates no job", async () => {
    const res = await request(server)
      .post("/api/verification/v1/preflight")
      .send({ target: { network: "testnet", contract_id: "C".repeat(56) } });

    expect(res.body?.error).not.toBe("draining");
  });
});
