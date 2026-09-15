import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * What `trust proxy` is worth, measured through the guard that depends on it. Without it every caller shares
 * the loopback peer address and one counter — invisible to a single-caller test, since the quota still
 * refuses, just the wrong people. The subject is therefore separation, not refusal.
 */
const LIMIT = 2;
process.env.SCVS_QUERY_THROTTLE_LIMIT = String(LIMIT);
// Lowering only the global one would leave the address tier above it, which boot refuses. This
// suite never drives the address route, so the value only has to be legal.
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

/** A caller address nothing else in this repository will impersonate. */
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

    // The assertion that fails if `trust proxy` is dropped: with the loopback peer address as the key, this
    // caller inherits the exhausted counter and is refused too.
    expect(await get(OTHER_CALLER)).not.toBe(429);
  });

  it("reads the client from the left of the forwarded chain, not the nearest proxy", async () => {
    // An ALB appends its own hop, so the value that arrives is `client, proxy`. Keying on the rightmost entry
    // would give every caller behind one balancer node the same identity.
    const chain = `${CALLER}, 10.0.0.7`;
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) statuses.push(await get(chain));

    expect(statuses.at(-1)).toBe(429);
    expect(await get(`${OTHER_CALLER}, 10.0.0.7`)).not.toBe(429);
  });
});
