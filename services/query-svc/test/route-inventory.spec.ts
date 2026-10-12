import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { routeInventoryProblems, type RouteDeclaration } from "@scvs/http/testing";

// Set before the import: the address tier's `@Throttle` is read when ResultsController is defined.
const GLOBAL_LIMIT = 4;
const ADDRESS_LIMIT = 2;
process.env.SCVS_QUERY_THROTTLE_LIMIT = String(GLOBAL_LIMIT);
process.env.SCVS_QUERY_ADDRESS_THROTTLE_LIMIT = String(ADDRESS_LIMIT);

const { createTestApp } = await import("./bootstrap.js");

const V1 = "/api/query/v1";
const PROBE = "a 429 to a health probe deregisters the task";
const DOCS = "adapter";

const DECLARED: RouteDeclaration[] = [
  { route: "GET /health", throttle: "skip", why: PROBE },
  { route: "GET /health/live", throttle: "skip", why: PROBE },
  { route: "GET /health/ready", throttle: "skip", why: PROBE },
  { route: `GET ${V1}/health`, throttle: "skip", why: PROBE },
  { route: "GET /internal/config-contract", throttle: "skip", why: "deployment configuration audit polls it" },
  { route: `GET ${V1}/wasms`, throttle: "global" },
  { route: `GET ${V1}/wasms.json`, throttle: "global" },
  { route: `GET ${V1}/wasms/:wasm_hash`, throttle: "global" },
  { route: `GET ${V1}/wasms/:wasm_hash.json`, throttle: "global" },
  { route: `GET ${V1}/contracts/:network/:contract_id`, throttle: "address" },
  { route: `GET ${V1}/verifiers`, throttle: "global" },
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
      overrideTiers: { address: ADDRESS_LIMIT },
      adapterLimit: GLOBAL_LIMIT,
      get: async (path, caller) =>
        (await request(app.getHttpServer()).get(path).set("x-forwarded-for", caller)).status,
    });
    expect(problems).toEqual([]);
  }, 30_000);
});
