import { jest } from "@jest/globals";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DbHealthService } from "@scvs/db-query";
import { DrainState } from "@scvs/core";
import { createTestApp } from "./bootstrap.js";

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

    expect(res.status).toBe(503);
    expect(res.body.ready).toBe(false);
    expect(res.body.checks.database).toEqual({ ok: false, detail: "connection refused" });
  });

  it("answers rather than hanging when the database stops responding", async () => {
    jest.spyOn(dbHealth, "ping").mockImplementation(async (timeoutMs = 2_000) => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return { ok: false, detail: `database did not answer SELECT 1 within ${timeoutMs}ms` };
    });

    const startedAt = Date.now();
    const res = await getReady();

    expect(res.status).toBe(503);
    expect(res.body.checks.database.ok).toBe(false);
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
