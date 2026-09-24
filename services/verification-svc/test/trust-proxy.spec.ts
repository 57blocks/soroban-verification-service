import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { Server } from "node:http";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AbuseControlRepository, createPrismaClient, readDbEnv } from "@scvs/db";
import { fingerprintRequest } from "../src/common/abuse-guard.js";
import { createTestApp } from "./bootstrap.js";

/** What `main.ts`'s `trust proxy` setting is worth, measured through the guard that depends on it. */
const prisma = createPrismaClient(readDbEnv());
const abuseControl = new AbuseControlRepository(prisma);

const ROUTE = "/api/verification/v1/verifications";
const WINDOW_MS = 60_000;
/** Low enough that a burst of three reaches it, and restored in `afterAll` — see below. */
const SUBMIT_LIMIT = 2;

const invented: string[] = [];

/** The window is part of the fingerprint, so a caller has one value per window it spent in. */
const fingerprintOf = (address: string, windowStartMs: number) =>
  fingerprintRequest(
    { ip: address } as Request,
    new Date(windowStartMs),
    process.env.SCVS_ABUSE_FINGERPRINT_KEY as string,
  );

/**
 * A caller address nothing else in the repository — no other spec, no parallel Jest worker, no previous run —
 * will ever impersonate.
 */
function inventCaller(): string {
  const groups = randomUUID().replace(/-/g, "").slice(0, 16).match(/.{4}/g) as string[];
  const address = `2001:db8:${groups.join(":")}::1`;
  invented.push(address);
  return address;
}

const windowStartOf = (now = Date.now()) => Math.floor(now / WINDOW_MS) * WINDOW_MS;

/** Sends `forwardedFor` values in order and reports the statuses. */
async function burst(server: Server, forwardedFor: string[]): Promise<number[]> {
  const statuses: number[] = [];
  for (const value of forwardedFor) {
    const res = await request(server).post(ROUTE).set("x-forwarded-for", value).send({});
    statuses.push(res.status);
  }
  return statuses;
}

/**
 * Runs `attempt` and repeats it once with fresh state if the wall clock crossed a window boundary mid-burst —
 * the one way a correct guard legitimately refuses nothing.
 */
async function withinOneWindow<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 0; ; tries++) {
    const before = windowStartOf();
    const result = await attempt();
    if (windowStartOf() === before || tries === 1) return result;
  }
}

let app: NestExpressApplication;
let server: Server;
let savedLimit: string | undefined;
let suiteStartedAt: number;

beforeAll(async () => {
  suiteStartedAt = Date.now();
  // jest.setup.cjs raises this to a number no suite can reach; the threshold is the subject here, so it has to
  // come back down.
  savedLimit = process.env.SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW;
  process.env.SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW = String(SUBMIT_LIMIT);
  app = await createTestApp();
  server = app.getHttpServer();
});

afterAll(async () => {
  if (savedLimit === undefined) delete process.env.SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW;
  else process.env.SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW = savedLimit;
  try {
    await app?.close();
    // Every window this run touched, so a burst that straddled a boundary still cleans up both of its rows.
    const windows: number[] = [];
    for (let at = windowStartOf(suiteStartedAt); at <= windowStartOf(); at += WINDOW_MS) windows.push(at);
    const fingerprints = invented.flatMap((address) =>
      windows.map((windowStartMs) => fingerprintOf(address, windowStartMs)),
    );
    await prisma.abuseControl.deleteMany({
      where: { submitterFingerprint: { in: fingerprints } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

describe("submitter identity behind a proxy", () => {
  it("counts one caller's requests against one budget", async () => {
    const statuses = await withinOneWindow(async () => {
      const caller = inventCaller();
      return burst(server, [caller, caller, caller]);
    });

    expect(statuses.slice(0, SUBMIT_LIMIT).every((status) => status !== 429)).toBe(true);
    expect(statuses[SUBMIT_LIMIT]).toBe(429);
  });

  it("gives a second caller its own budget", async () => {
    const { spender, bystander } = await withinOneWindow(async () => {
      const first = inventCaller();
      return {
        spender: await burst(server, Array<string>(SUBMIT_LIMIT + 1).fill(first)),
        bystander: await burst(server, [inventCaller()]),
      };
    });

    expect(spender[SUBMIT_LIMIT]).toBe(429);
    expect(bystander[0]).not.toBe(429);
  });

  // The ALB APPENDS the address it observed, and a client can only prepend, so the entry that identifies the
  // caller is the rightmost one.
  it("ignores an X-Forwarded-For entry the caller prepended itself", async () => {
    const statuses = await withinOneWindow(async () => {
      const caller = inventCaller();
      const spoofed = inventCaller();
      return burst(server, [caller, caller, `${spoofed}, ${caller}`]);
    });

    expect(statuses[SUBMIT_LIMIT]).toBe(429);
  });
});

// The fallback matters on its own: a deployment with nothing in front of it must not become unmetered.
it("falls back to the socket address when no forwarding header is sent", async () => {
  // Which of these Node reports depends on whether the server bound a dual-stack socket; all three are
  // loopback, and asserting on the set is honest where asserting on one shape would be a guess.
  const loopback = ["127.0.0.1", "::ffff:127.0.0.1", "::1"];
  const total = async () => {
    const windowStartMs = windowStartOf();
    const windowStart = new Date(windowStartMs);
    const counts = await Promise.all(
      loopback.map((address) =>
        abuseControl.getAbuseCount(fingerprintOf(address, windowStartMs), ROUTE, windowStart),
      ),
    );
    return counts.reduce((sum, count) => sum + count, 0);
  };

  const [before, after] = await withinOneWindow(async () => {
    const start = await total();
    await request(server).post(ROUTE).send({});
    return [start, await total()];
  });

  // `>=` and not `+ 1`: parallel workers share this row, so a larger delta is another suite submitting, which
  // is the behaviour under test rather than interference with it.
  expect(after).toBeGreaterThanOrEqual(before + 1);
});
