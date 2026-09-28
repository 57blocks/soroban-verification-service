import { randomUUID } from "node:crypto";
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

const JOB_ROUTE = `/api/verification/v1/verifications/${randomUUID()}`;

describe("response headers", () => {
  it("sends no-store, noindex and a strict referrer policy on a job response", async () => {
    const res = await request(server).get(JOB_ROUTE);

    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("sends them on the build log route too", async () => {
    const res = await request(server).get(`${JOB_ROUTE}/log`);

    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("sends them on a submission, which carries the job it just created", async () => {
    const res = await request(server).post("/api/verification/v1/verifications").send({});

    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });

  it("does NOT send no-store on the bulk-load stream", async () => {
    const res = await request(server).get("/api/verification/v1/wasms?limit=1");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });
});
