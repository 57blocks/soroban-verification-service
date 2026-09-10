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
  // The same instance the guard and the health controller resolve — DrainModule is global precisely so there is
  // only one.
  drain = app.get(DrainState);
});

afterAll(async () => {
  await app.close();
});

/**
 * O9's draining obligations, as behaviour: "stop accepting new jobs while in-flight jobs finish; what the API
 * returns during the drain".
 */
describe("before a drain", () => {
  it("is ready, and says nothing is draining", async () => {
    const res = await request(server).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ready: true, draining: false });
    // The DB check must be *reported*, not implied — a readiness body that names no check cannot be told apart
    // from one that probed nothing.
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
    // 503 is what a balancer and a deployment tool read; the body is for the human.
    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.draining).toBe(true);
    expect(typeof res.body.draining_since).toBe("string");
    // Draining is not a dependency failure: the database is still fine and must still say so, or an operator
    // reading this cannot tell a drain from an outage.
    expect(res.body.checks.database.ok).toBe(true);
  });

  it("liveness stays 200 — a drain must not get the task restarted", async () => {
    // The whole point of the split. A liveness failure here would kill a task that is deliberately shutting
    // down, turning an orderly deployment into a restart.
    const res = await request(server).get("/health/live");
    expect(res.status).toBe(200);
  });

  it("`/health` is unchanged, because the deployment reads it", async () => {
    // The container HEALTHCHECK and the ALB target group point at this route.
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
    // The message has to tell a submitter their accepted jobs are unaffected, or a 503 during a deployment
    // reads as "my verification was lost".
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
    // A drain must not blind a submitter watching a job that is still running, and it *is* still running: a
    // rebuild already dispatched to Batch outlives this process (O6).
    const res = await request(server).get("/api/verification/v1/verifications/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("still serves preflight — it creates no job", async () => {
    // Preflight reads the chain and creates nothing, so refusing it would cost a submitter information without
    // protecting anything.
    const res = await request(server)
      .post("/api/verification/v1/preflight")
      .send({ target: { network: "testnet", contract_id: "C".repeat(56) } });

    expect(res.body?.error).not.toBe("draining");
  });
});
