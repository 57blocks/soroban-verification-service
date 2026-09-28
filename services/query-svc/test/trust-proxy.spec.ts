import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";

const LIMIT = 2;
process.env.SCVS_QUERY_THROTTLE_LIMIT = String(LIMIT);
// Must stay below the global limit or boot refuses.
process.env.SCVS_QUERY_ADDRESS_THROTTLE_LIMIT = "1";

const SOME_HASH = "b".repeat(64);

let app: NestExpressApplication;

beforeAll(async () => {
  const { createTestApp } = await import("./bootstrap.js");
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

const CALLER = "2001:db8:7a51:1::1";
const OTHER_CALLER = "2001:db8:7a51:2::1";

async function get(forwardedFor: string): Promise<number> {
  const res = await request(app.getHttpServer())
    .get(`/api/query/v1/wasms/${SOME_HASH}`)
    .set("x-forwarded-for", forwardedFor);
  return res.status;
}

describe("trust proxy", () => {
  it("keys the quota on the forwarded address, so one caller cannot spend another's budget", async () => {
    const spender: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) spender.push(await get(CALLER));

    expect(spender.at(-1)).toBe(429);

    expect(await get(OTHER_CALLER)).not.toBe(429);
  });

  it("reads the client from the left of the forwarded chain, not the nearest proxy", async () => {
    const chain = `${CALLER}, 10.0.0.7`;
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) statuses.push(await get(chain));

    expect(statuses.at(-1)).toBe(429);
    expect(await get(`${OTHER_CALLER}, 10.0.0.7`)).not.toBe(429);
  });
});
