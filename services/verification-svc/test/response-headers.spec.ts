import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTestApp } from "./bootstrap.js";

/**
 * RP-5: job and log content is not cached by intermediaries, indexed, or leaked through the referrer.
 *
 * `Referrer-Policy` is helmet's default rather than anything this repository sets — which is exactly why it is
 * asserted here: configuring helmet for some other reason would drop it silently.
 */
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

  // The bulk-load stream exists to be polled and cached by consumers; `no-store` there would break the
  // feature this ticket is careful not to break.
  it("does NOT send no-store on the bulk-load stream", async () => {
    const res = await request(server).get("/api/verification/v1/wasms?limit=1");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBeUndefined();
    // It is still not for a crawler, though.
    expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
  });
});
