import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";

// Set before the dynamic import: `@Throttle()` reads the address tier when ResultsController is defined.
const GLOBAL_LIMIT = 10;
const ADDRESS_LIMIT = 3;
process.env.SCVS_QUERY_THROTTLE_LIMIT = String(GLOBAL_LIMIT);
process.env.SCVS_QUERY_ADDRESS_THROTTLE_LIMIT = String(ADDRESS_LIMIT);

/** CRC-valid and never deployed. */
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

    expect(statuses.slice(0, GLOBAL_LIMIT).filter((status) => status === 429)).toEqual([]);
    expect(statuses.at(-1)).toBe(429);

    const refused = await request(app.getHttpServer())
      .get(`/api/query/v1/wasms/${SOME_HASH}`)
      .set("x-forwarded-for", "198.51.100.1");

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
    expect(statuses.at(-1)).toBe(429);
    expect(ADDRESS_LIMIT).toBeLessThan(GLOBAL_LIMIT);
  });

  it("spends only its own budget — a caller cut off here can still read by hash", async () => {
    const caller = "198.51.100.5";
    const address = await burst(`/api/query/v1/contracts/testnet/${SOME_ADDRESS}`, ADDRESS_LIMIT + 1, caller);
    expect(address.at(-1)).toBe(429);

    const byHash = await burst(`/api/query/v1/wasms/${SOME_HASH}`, 1, caller);
    expect(byHash[0]).not.toBe(429);
  });
});

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

    const api = await burst(`/api/query/v1/wasms/${SOME_HASH}`, 1, caller);
    expect(api[0]).not.toBe(429);
  });
});

describe("routes exempt from the quota", () => {
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
