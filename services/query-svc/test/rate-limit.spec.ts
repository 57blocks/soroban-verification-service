import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * Set before the app module loads, and why `createTestApp` is imported dynamically: the address tier is a
 * `@Throttle()` argument, evaluated when `ResultsController` is defined, which a static import would run
 * ahead of these assignments.
 */
const GLOBAL_LIMIT = 10;
const ADDRESS_LIMIT = 3;
process.env.SCVS_QUERY_THROTTLE_LIMIT = String(GLOBAL_LIMIT);
process.env.SCVS_QUERY_ADDRESS_THROTTLE_LIMIT = String(ADDRESS_LIMIT);

/** CRC-valid, and never deployed — the request is refused by the quota or by the aggregation gate, never resolved. */
const SOME_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const SOME_HASH = "a".repeat(64);

let app: NestExpressApplication;

beforeAll(async () => {
  const { createTestApp } = await import("./bootstrap.js");
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

/**
 * Sends `count` requests to `path` as one caller and reports the statuses. Each caller gets an address nothing
 * else in this file reuses, so one case cannot spend another's budget.
 */
async function burst(path: string, count: number, caller: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await request(app.getHttpServer()).get(path).set("x-forwarded-for", caller);
    statuses.push(res.status);
  }
  return statuses;
}

describe("the global read quota", () => {
  it("refuses past the ceiling, and says so in the shared error envelope", async () => {
    const statuses = await burst(`/api/query/v1/wasms/${SOME_HASH}`, GLOBAL_LIMIT + 1, "198.51.100.1");

    // Everything up to the ceiling gets past the guard. What the handler then answers is not this suite's
    // subject — with no aggregation pass it is a 503 — so the assertion is only that it was not refused here.
    expect(statuses.slice(0, GLOBAL_LIMIT).filter((status) => status === 429)).toEqual([]);
    expect(statuses.at(-1)).toBe(429);

    const refused = await request(app.getHttpServer())
      .get(`/api/query/v1/wasms/${SOME_HASH}`)
      .set("x-forwarded-for", "198.51.100.1");

    // RC6's vocabulary, not `request_failed` — the code a bare ThrottlerException would have produced.
    expect(refused.body).toEqual({
      schema: "stellar-verification-error",
      schema_version: "1.0",
      error: "rate_limited",
      message: "Too many requests, please try again later.",
      status_code: 429,
    });
  });

  it("counts each caller separately", async () => {
    const spender = await burst(`/api/query/v1/wasms/${SOME_HASH}`, GLOBAL_LIMIT + 1, "198.51.100.2");
    expect(spender.at(-1)).toBe(429);

    // A second caller arriving after the first has been cut off is unaffected — the quota is per caller, which
    // is the whole point of trusting the forwarded address (see trust-proxy.spec.ts).
    const bystander = await burst(`/api/query/v1/wasms/${SOME_HASH}`, 1, "198.51.100.3");
    expect(bystander[0]).not.toBe(429);
  });
});

describe("the address route's tighter tier", () => {
  it("refuses it sooner than the global ceiling, because each request costs an upstream call", async () => {
    const statuses = await burst(
      `/api/query/v1/contracts/testnet/${SOME_ADDRESS}`,
      ADDRESS_LIMIT + 1,
      "198.51.100.4",
    );

    expect(statuses.slice(0, ADDRESS_LIMIT).filter((status) => status === 429)).toEqual([]);
    // The ceiling this route enforces is its own, and it is reached well before GLOBAL_LIMIT requests.
    expect(statuses.at(-1)).toBe(429);
    expect(ADDRESS_LIMIT).toBeLessThan(GLOBAL_LIMIT);
  });

  it("spends only its own budget — a caller cut off here can still read by hash", async () => {
    const caller = "198.51.100.5";
    const address = await burst(`/api/query/v1/contracts/testnet/${SOME_ADDRESS}`, ADDRESS_LIMIT + 1, caller);
    expect(address.at(-1)).toBe(429);

    // Per-route counters: exhausting the route that reaches a third party must not take the rest of the read
    // surface down with it.
    const byHash = await burst(`/api/query/v1/wasms/${SOME_HASH}`, 1, caller);
    expect(byHash[0]).not.toBe(429);
  });
});

/** Swagger registers on the HTTP adapter, out of the guard chain — covered by middleware instead. */
describe("the documentation surface, throttled outside the guard chain", () => {
  it.each(["/api/query/v1/openapi.json", "/api/query/v1/docs"])(
    "%s is refused past the ceiling, in the same envelope as any other route",
    async (path) => {
      const caller = `198.51.100.${path.includes("docs") ? 20 : 21}`;
      const statuses = await burst(path, GLOBAL_LIMIT + 1, caller);

      expect(statuses.at(-1)).toBe(429);

      const refused = await request(app.getHttpServer()).get(path).set("x-forwarded-for", caller);
      expect(refused.body).toMatchObject({
        schema: "stellar-verification-error",
        error: "rate_limited",
        status_code: 429,
      });
    },
  );

  it("spends its own budget, not the API's", async () => {
    const caller = "198.51.100.22";
    const docs = await burst("/api/query/v1/openapi.json", GLOBAL_LIMIT + 1, caller);
    expect(docs.at(-1)).toBe(429);

    // Reading the document to exhaustion must not cost the same caller its ability to query.
    const api = await burst(`/api/query/v1/wasms/${SOME_HASH}`, 1, caller);
    expect(api[0]).not.toBe(429);
  });
});

describe("routes exempt from the quota", () => {
  // A probe refused with 429 is a probe that failed: throttling these would let the quota deregister a task
  // for being polled at exactly the rate its operator configured.
  it.each([
    ["/health", "the container HEALTHCHECK and the ALB target group"],
    ["/health/live", "liveness"],
    ["/health/ready", "readiness"],
    ["/api/query/v1/health", "the versioned health route"],
    ["/internal/config-contract", "deployment configuration audit"],
  ])("never throttles %s (%s)", async (path) => {
    const statuses = await burst(path, GLOBAL_LIMIT + 5, "198.51.100.6");
    expect(statuses.filter((status) => status === 429)).toEqual([]);
  });
});
