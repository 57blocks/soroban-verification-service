import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";

// Set before the dynamic import: `@Throttle()` reads the read tier when the controllers are defined.
const READ_LIMIT = 4;
process.env.SCVS_READ_THROTTLE_LIMIT = String(READ_LIMIT);

const { createTestApp } = await import("./bootstrap.js");

const SOME_HASH = "a".repeat(64);

let app: NestExpressApplication;

beforeAll(async () => {
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

const RATE_LIMITED = {
  schema: "stellar-verification-error",
  schema_version: "1.0",
  error: "rate_limited",
  message: "Too many requests, please try again later.",
  status_code: 429,
};

describe("the public read routes carry a quota", () => {
  it.each([
    ["/api/verification/v1/wasms?limit=1", "198.51.100.1"],
    ["/api/verification/v1/wasms.json?limit=1", "198.51.100.2"],
    [`/api/verification/v1/wasms/${SOME_HASH}.json`, "198.51.100.3"],
  ])("%s is refused past the ceiling, in the shared error envelope", async (path, caller) => {
    const statuses = await burst(path, READ_LIMIT + 1, caller);

    expect(statuses.slice(0, READ_LIMIT).filter((status) => status === 429)).toEqual([]);
    expect(statuses.at(-1)).toBe(429);

    const refused = await request(app.getHttpServer()).get(path).set("x-forwarded-for", caller);
    expect(refused.body).toEqual(RATE_LIMITED);
  });

  it("counts each caller separately", async () => {
    const path = "/api/verification/v1/wasms?limit=1";
    expect((await burst(path, READ_LIMIT + 1, "198.51.100.4")).at(-1)).toBe(429);
    expect((await burst(path, 1, "198.51.100.5"))[0]).not.toBe(429);
  });

  it("keeps the job-status route exempt, so a submitter polling its own job is never refused", async () => {
    const statuses = await burst(
      "/api/verification/v1/verifications/00000000-0000-4000-8000-000000000000",
      READ_LIMIT * 3,
      "198.51.100.6",
    );
    expect(statuses.filter((status) => status === 429)).toEqual([]);
  });
});

describe("the documentation surface, throttled outside the guard chain", () => {
  it.each([
    ["/api/verification/v1/openapi.json", "198.51.100.20"],
    ["/api/verification/v1/docs", "198.51.100.21"],
  ])("%s is refused past the ceiling, in the same envelope as any other route", async (path, caller) => {
    const statuses = await burst(path, READ_LIMIT + 1, caller);
    expect(statuses.at(-1)).toBe(429);

    const refused = await request(app.getHttpServer()).get(path).set("x-forwarded-for", caller);
    expect(refused.body).toMatchObject({ error: "rate_limited", status_code: 429 });
  });

  it("spends its own budget, not the API's", async () => {
    const caller = "198.51.100.22";
    expect((await burst("/api/verification/v1/openapi.json", READ_LIMIT + 1, caller)).at(-1)).toBe(429);
    expect((await burst("/api/verification/v1/wasms?limit=1", 1, caller))[0]).not.toBe(429);
  });
});
