import { jest } from "@jest/globals";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DbHealthService } from "@scvs/db-query";
import { DrainState } from "@scvs/core";
import { createTestApp } from "./bootstrap.js";

/** `/health/ready` used to call `readiness(drain, {})` — an empty check set, so only draining made it false. */
let app: NestExpressApplication;
let dbHealth: DbHealthService;

beforeAll(async () => {
  app = await createTestApp();
  dbHealth = app.get(DbHealthService);
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const getReady = () => request(app.getHttpServer()).get("/health/ready");

describe("GET /health/ready", () => {
  it("reports ready, and names the dependency it actually probed", async () => {
    const res = await getReady();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ready: true, draining: false, checks: { database: { ok: true } } });
  });

  it("turns false when the database is unreachable", async () => {
    jest
      .spyOn(dbHealth, "ping")
      .mockResolvedValue({ ok: false, detail: "connection refused" });

    const res = await getReady();

    // 503, not a 200 carrying a failed check: the balancer reads the status line, not the body.
    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.checks.database).toEqual({ ok: false, detail: "connection refused" });
  });

  it("answers rather than hanging when the database stops responding", async () => {
    // The failure `connectionTimeoutMillis` does not cover: the statement was accepted and no answer came.
    jest.spyOn(dbHealth, "ping").mockImplementation(async (timeoutMs = 2_000) => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return { ok: false, detail: `database did not answer SELECT 1 within ${timeoutMs}ms` };
    });

    const startedAt = Date.now();
    const res = await getReady();

    expect(res.status).toBe(503);
    expect(res.body.checks.database.ok).toBe(false);
    // The bound is what this asserts, not the exact duration: an unbounded probe never reaches this line.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it("is false while draining even with a healthy database", async () => {
    const drain = app.get(DrainState);
    jest.spyOn(drain, "isDraining", "get").mockReturnValue(true);

    const res = await getReady();

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ready: false, draining: true, checks: { database: { ok: true } } });
  });
});

describe("the probe's own bound", () => {
  it("resolves rather than rejecting when the query outlives the timeout", async () => {
    // Straight at the service: a rejected promise here would surface as a 500 from the route above, which is
    // not what a readiness probe should answer.
    // `$queryRaw` is called as a tagged template, so the stub only has to be callable as the tag.
    const never = new Promise(() => {});
    const pingWithStubbedQuery = DbHealthService.prototype.ping.call(
      { prisma: { $queryRaw: () => never } } as never,
      50,
    );

    await expect(pingWithStubbedQuery).resolves.toEqual({
      ok: false,
      detail: "database did not answer SELECT 1 within 50ms",
    });
  });
});
