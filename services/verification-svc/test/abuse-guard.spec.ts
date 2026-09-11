import { randomUUID } from "node:crypto";
import type { Request } from "express";
import {
  AbuseControlRepository,
  createPrismaClient,
  readDbEnv,
} from "@scvs/db";
import { AbuseGuardService, fingerprintRequest } from "../src/common/abuse-guard.js";
import { AbuseGuard } from "../src/common/abuse.guard.js";

/**
 * The Postgres-backed sliding window's own behaviour — untested until now, which is how it came to break every
 * *other* spec in this service unnoticed.
 */
const prisma = createPrismaClient(readDbEnv());
const FINGERPRINT_KEY = process.env.SCVS_ABUSE_FINGERPRINT_KEY as string;
const abuse = new AbuseGuardService(new AbuseControlRepository(prisma), {
  get: () => FINGERPRINT_KEY,
} as never);

const WINDOW_MS = 60_000;
const ROUTE = "/api/verification/v1/verifications";
const clientIps: string[] = [];

/** A request from a client nothing else in the repository will ever impersonate. */
function requestFromNewClient(): Request {
  // Fingerprinted, never parsed, so a unique opaque string identifies a client as well as an address does.
  const ip = `test-client-${randomUUID()}`;
  clientIps.push(ip);
  return { ip } as Request;
}

/** An instant in the middle of some window, so neither edge is nearby. */
const SOME_WINDOW = 1_800_000_000_000;

/** The two window starts this suite spends budget in — the fingerprint differs per window. */
const USED_WINDOWS = [SOME_WINDOW, SOME_WINDOW + WINDOW_MS].map(
  (at) => new Date(Math.floor(at / WINDOW_MS) * WINDOW_MS),
);

afterAll(async () => {
  try {
    const fingerprints = clientIps.flatMap((ip) =>
      USED_WINDOWS.map((windowStart) =>
        fingerprintRequest({ ip } as Request, windowStart, FINGERPRINT_KEY),
      ),
    );
    await prisma.abuseControl.deleteMany({
      where: { submitterFingerprint: { in: fingerprints } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

describe("AbuseGuardService", () => {
  it("allows exactly the budget and refuses the request after it", async () => {
    const req = requestFromNewClient();

    const verdicts = [];
    for (let i = 0; i < 4; i++) {
      verdicts.push(
        (await abuse.checkAbuse(req, ROUTE, 3, WINDOW_MS, SOME_WINDOW)).allowed,
      );
    }

    expect(verdicts).toEqual([true, true, true, false]);
  });

  it("counts each client separately", async () => {
    const spender = requestFromNewClient();
    const bystander = requestFromNewClient();

    await abuse.checkAbuse(spender, ROUTE, 1, WINDOW_MS, SOME_WINDOW);
    await abuse.checkAbuse(spender, ROUTE, 1, WINDOW_MS, SOME_WINDOW);

    // Two Jest workers hitting 127.0.0.1 are one client by this definition, which is why jest.setup.cjs raises
    // the ceiling rather than relying on this.
    expect(
      (await abuse.checkAbuse(spender, ROUTE, 1, WINDOW_MS, SOME_WINDOW))
        .allowed,
    ).toBe(false);
    expect(
      (await abuse.checkAbuse(bystander, ROUTE, 1, WINDOW_MS, SOME_WINDOW))
        .allowed,
    ).toBe(true);
  });

  it("starts a fresh budget in the next window", async () => {
    const req = requestFromNewClient();

    await abuse.checkAbuse(req, ROUTE, 1, WINDOW_MS, SOME_WINDOW);
    expect(
      (await abuse.checkAbuse(req, ROUTE, 1, WINDOW_MS, SOME_WINDOW)).allowed,
    ).toBe(false);

    // A spent budget must expire rather than wedge the client out permanently — the bound
    // `getActiveJobForTarget`'s staleness window provides on the dedup side.
    expect(
      (
        await abuse.checkAbuse(
          req,
          ROUTE,
          1,
          WINDOW_MS,
          SOME_WINDOW + WINDOW_MS,
        )
      ).allowed,
    ).toBe(true);
  });

  it("counts each route separately", async () => {
    const req = requestFromNewClient();

    await abuse.checkAbuse(req, "/api/verification/v1/verifications", 1, WINDOW_MS, SOME_WINDOW);
    expect(
      (
        await abuse.checkAbuse(
          req,
          "/api/verification/v1/verifications",
          1,
          WINDOW_MS,
          SOME_WINDOW,
        )
      ).allowed,
    ).toBe(false);

    // The point of the route dimension: one client exhausting its submission budget must still be able to
    // preflight.
    expect(
      (await abuse.checkAbuse(req, "/api/verification/v1/preflight", 1, WINDOW_MS, SOME_WINDOW))
        .allowed,
    ).toBe(true);
    expect(
      (
        await abuse.checkAbuse(
          req,
          "/api/verification/v1/uploads/source",
          1,
          WINDOW_MS,
          SOME_WINDOW,
        )
      ).allowed,
    ).toBe(true);
  });

  // RP-1: the stored value must not be reversible, and must not link one client across windows.
  it("produces an unrelated fingerprint for the same address in the next window", () => {
    const req = { ip: "203.0.113.7" } as Request;
    const [first, second] = USED_WINDOWS.map((windowStart) =>
      fingerprintRequest(req, windowStart, FINGERPRINT_KEY),
    );

    expect(first).not.toBe(second);
    // And the key is what makes either of them unguessable: the same address under a different key is a
    // different value, which an unsalted hash of the address could never be.
    expect(fingerprintRequest(req, USED_WINDOWS[0], "a-different-key")).not.toBe(first);
  });

  // Independent counters mean a client's total is the SUM of the tiers, not the largest of them.
  it("keeps the built-in defaults summing to the previous single ceiling", async () => {
    // jest.setup.cjs raises both to a number no suite can reach, so the defaults are only observable with the
    // overrides out of the way.
    const saved = [
      process.env.SCVS_ABUSE_MAX_PER_WINDOW,
      process.env.SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW,
    ];
    delete process.env.SCVS_ABUSE_MAX_PER_WINDOW;
    delete process.env.SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW;
    try {
      const { default: configuration } =
        await import("../src/config/configuration.js");
      const config = configuration();
      expect(
        config.abuseMaxPerWindow + 2 * config.submitAbuseMaxPerWindow,
      ).toBe(30);
    } finally {
      [
        process.env.SCVS_ABUSE_MAX_PER_WINDOW,
        process.env.SCVS_SUBMIT_ABUSE_MAX_PER_WINDOW,
      ] = saved as [string, string];
    }
  });

  it("keeps the in-process tier's default at 60 and honours an override", async () => {
    const saved = process.env.SCVS_THROTTLE_LIMIT;
    try {
      delete process.env.SCVS_THROTTLE_LIMIT;
      const { default: configuration } =
        await import("../src/config/configuration.js");
      expect(configuration().throttleLimit).toBe(60);

      process.env.SCVS_THROTTLE_LIMIT = "77";
      expect(configuration().throttleLimit).toBe(77);
    } finally {
      if (saved === undefined) delete process.env.SCVS_THROTTLE_LIMIT;
      else process.env.SCVS_THROTTLE_LIMIT = saved;
    }
  });
});

/**
 * The guard's own tier selection, which `AbuseGuardService` above never sees: it matches the matched-route
 * pattern against a hardcoded set of literal paths.
 */
describe("AbuseGuard tier selection", () => {
  const guardFor = (routePath: string) => {
    const budgets: Record<string, number> = {
      abuseMaxPerWindow: 18,
      submitAbuseMaxPerWindow: 6,
      abuseWindowMs: WINDOW_MS,
    };
    const seen: Array<{ route: string; maxPerWindow: number }> = [];
    const guard = new AbuseGuard(
      { get: (key: string) => budgets[key] } as never,
      {
        checkAbuse: async (
          _req: unknown,
          route: string,
          maxPerWindow: number,
        ) => {
          seen.push({ route, maxPerWindow });
          return { allowed: true };
        },
      } as never,
    );
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ ip: "203.0.113.9", route: { path: routePath } }),
      }),
    } as never;
    return { guard, context, seen };
  };

  it.each([
    ["/api/verification/v1/verifications", 6],
    ["/api/verification/v1/uploads/source", 6],
    ["/api/verification/v1/preflight", 18],
  ])("bills %s against the %i budget", async (routePath, expected) => {
    const { guard, context, seen } = guardFor(routePath as string);
    await guard.canActivate(context);
    expect(seen).toEqual([{ route: routePath, maxPerWindow: expected }]);
  });

  // The two submission routes are the same tier but not the same counter — their budgets are independent, which
  // is what makes a client's total the sum rather than the largest.
  it("keys the counter on the route, so the two submission routes do not share one", async () => {
    const submit = guardFor("/api/verification/v1/verifications");
    const upload = guardFor("/api/verification/v1/uploads/source");
    await submit.guard.canActivate(submit.context);
    await upload.guard.canActivate(upload.context);
    expect(submit.seen[0].route).not.toBe(upload.seen[0].route);
  });
});

// The fallback's direction is the point: this guard only sits on routes that have a budget, so reaching it
// means the pattern could not be read.
describe("AbuseGuard fallback when the route pattern is unavailable", () => {
  it("bills an unmatched request against the strictest tier", async () => {
    const budgets: Record<string, number> = {
      abuseMaxPerWindow: 18,
      submitAbuseMaxPerWindow: 6,
      abuseWindowMs: WINDOW_MS,
    };
    const seen: Array<{ route: string; maxPerWindow: number }> = [];
    const guard = new AbuseGuard(
      { get: (key: string) => budgets[key] } as never,
      {
        checkAbuse: async (
          _req: unknown,
          route: string,
          maxPerWindow: number,
        ) => {
          seen.push({ route, maxPerWindow });
          return { allowed: true };
        },
      } as never,
    );

    // No `route` on the request at all — what a global prefix or a middleware mount would produce.
    await guard.canActivate({
      switchToHttp: () => ({ getRequest: () => ({ ip: "203.0.113.10" }) }),
    } as never);

    expect(seen).toEqual([{ route: "unmatched", maxPerWindow: 6 }]);
  });
});
