import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { routeInventoryProblems, type RouteDeclaration } from "@scvs/http/testing";

// Distinct values, set before the import: each `@Throttle` override is read when its controller is defined.
const READ_LIMIT = 3;
const UPLOAD_LIMIT = 997;
process.env.SCVS_READ_THROTTLE_LIMIT = String(READ_LIMIT);
process.env.SCVS_UPLOAD_RATE_LIMIT_PER_MINUTE = String(UPLOAD_LIMIT);

const { createTestApp } = await import("./bootstrap.js");

const V1 = "/api/verification/v1";
const PROBE = "a 429 to a health probe deregisters the task";
const DOCS = "adapter";

const DECLARED: RouteDeclaration[] = [
  { route: "GET /health", throttle: "skip", why: PROBE },
  { route: "GET /health/live", throttle: "skip", why: PROBE },
  { route: "GET /health/ready", throttle: "skip", why: PROBE },
  { route: `GET ${V1}/health`, throttle: "skip", why: PROBE },
  { route: "GET /internal/config-contract", throttle: "global" },
  { route: `GET ${V1}/legal`, throttle: "global" },
  { route: `POST ${V1}/preflight`, throttle: "global", guards: ["AbuseGuard"] },
  { route: `POST ${V1}/verifications`, throttle: "global", guards: ["DrainGuard", "AbuseGuard"] },
  { route: `POST ${V1}/uploads/source`, throttle: "upload" },
  {
    route: `GET ${V1}/verifications/:job_id`,
    throttle: "skip",
    why: "a submitter polling its own accepted job must never be refused",
  },
  { route: `GET ${V1}/verifications/:job_id/log`, throttle: "global", guards: ["AbuseGuard"] },
  { route: `DELETE ${V1}/verifications/:job_id/log`, throttle: "global", guards: ["AbuseGuard"] },
  {
    route: `GET ${V1}/verifications/:job_id/events`,
    throttle: "skip",
    guards: ["AbuseGuard"],
    why: "an open stream is not a request; opening one is metered by AbuseGuard and the connection caps",
  },
  { route: `GET ${V1}/wasms`, throttle: "read" },
  { route: `GET ${V1}/wasms.json`, throttle: "read" },
  { route: `GET ${V1}/wasms/:wasm_hash.json`, throttle: "read" },
  { route: "ALL /*path", throttle: "global" },
  { route: `GET ${V1}/openapi.json`, throttle: DOCS },
  { route: `GET ${V1}/docs-yaml`, throttle: DOCS },
  { route: `GET ${V1}/docs`, throttle: DOCS },
  { route: `GET ${V1}/docs/index.html`, throttle: DOCS },
  { route: `GET ${V1}/docs/LICENSE`, throttle: DOCS },
  { route: `GET ${V1}/docs/swagger-ui-init.js`, throttle: DOCS },
  { route: `GET ${V1}/docs/docs/swagger-ui-init.js`, throttle: DOCS },
];

let app: NestExpressApplication;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe("every route this service serves is declared with its throttle tier", () => {
  it("matches what the running app registers, controller and HTTP adapter alike", async () => {
    const problems = await routeInventoryProblems(app, DECLARED, {
      overrideTiers: { read: READ_LIMIT, upload: UPLOAD_LIMIT },
      adapterLimit: READ_LIMIT,
      get: async (path, caller) =>
        (await request(app.getHttpServer()).get(path).set("x-forwarded-for", caller)).status,
    });
    expect(problems).toEqual([]);
  }, 30_000);
});
