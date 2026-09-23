import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { ScvsLogger } from "@scvs/core";
import {
  AbuseControlRepository,
  createPrismaClient,
  readDbEnv,
} from "@scvs/db";
import { AbuseGuardService, fingerprintIp, fingerprintRequest } from "../src/common/abuse-guard.js";
import { AbuseGuard } from "../src/common/abuse.guard.js";
import type { ApiError } from "@scvs/http";

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

  // Both of checkAbuseFailOpen's callers (this guard, RawArchiveBodyMiddleware) rely on this: the check must
  // not take the route down with the database.
  it("fails open when the underlying check errors, and does not throw", async () => {
    const brokenAbuseControl = {
      incrementAbuseCounter: () => Promise.reject(new Error("connection refused")),
    } as unknown as AbuseControlRepository;
    const broken = new AbuseGuardService(brokenAbuseControl, { get: () => FINGERPRINT_KEY } as never);
    const logger = new ScvsLogger("test");

    await expect(
      broken.checkAbuseFailOpen(requestFromNewClient(), ROUTE, 3, WINDOW_MS, logger),
    ).resolves.toEqual({ allowed: true });
  });

  it("fails closed once consecutive failures exceed the threshold, and resets on the next success", async () => {
    let shouldFail = true;
    const flaky = {
      incrementAbuseCounter: () =>
        shouldFail ? Promise.reject(new Error("connection refused")) : Promise.resolve(1),
    } as unknown as AbuseControlRepository;
    const guard = new AbuseGuardService(flaky, { get: () => FINGERPRINT_KEY } as never);
    const logger = new ScvsLogger("test");
    const req = requestFromNewClient();
    const threshold = 2;

    // Exactly `threshold` failures still fail open.
    for (let i = 0; i < threshold; i++) {
      await expect(
        guard.checkAbuseFailOpen(req, ROUTE, 3, WINDOW_MS, logger, threshold),
      ).resolves.toEqual({ allowed: true });
    }

    // The (threshold + 1)th consecutive failure fails closed.
    await expect(
      guard.checkAbuseFailOpen(req, ROUTE, 3, WINDOW_MS, logger, threshold),
    ).resolves.toEqual({ allowed: false, reason: "fail_closed" });

    // One success in between resets the counter, so the next failure run gets the full threshold again.
    shouldFail = false;
    await guard.checkAbuseFailOpen(req, ROUTE, 3, WINDOW_MS, logger, threshold);
    shouldFail = true;
    for (let i = 0; i < threshold; i++) {
      await expect(
        guard.checkAbuseFailOpen(req, ROUTE, 3, WINDOW_MS, logger, threshold),
      ).resolves.toEqual({ allowed: true });
    }
    await expect(
      guard.checkAbuseFailOpen(req, ROUTE, 3, WINDOW_MS, logger, threshold),
    ).resolves.toEqual({ allowed: false, reason: "fail_closed" });
  });
});

/**
 * The guard's own tier selection, which `AbuseGuardService` above never sees: it matches the matched-route
 * pattern against a hardcoded set of literal paths.
 *
 * `uploads/source` is exercised directly on the guard below, not through the controller: that route no longer
 * has `@UseGuards(AbuseGuard)` (RawArchiveBodyMiddleware runs the check instead), but `SUBMISSION_ROUTES` still
 * names it.
 */
describe("AbuseGuard tier selection", () => {
  const guardFor = (routePath: string) => {
    const budgets: Record<string, number> = {
      abuseMaxPerWindow: 18,
      submitAbuseMaxPerWindow: 6,
      streamAbuseMaxPerWindow: 60,
      abuseWindowMs: WINDOW_MS,
    };
    const seen: Array<{ route: string; maxPerWindow: number }> = [];
    const guard = new AbuseGuard(
      { get: (key: string) => budgets[key] } as never,
      {
        checkAbuseFailOpen: async (
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
    ["/api/verification/v1/preflight", 18],
  ])("bills %s against the %i budget", async (routePath, expected) => {
    const { guard, context, seen } = guardFor(routePath as string);
    await guard.canActivate(context);
    expect(seen).toEqual([{ route: routePath, maxPerWindow: expected }]);
  });

  it("bills uploads/source against the strict budget", async () => {
    const { guard, context, seen } = guardFor("/api/verification/v1/uploads/source");
    await guard.canActivate(context);
    expect(seen).toEqual([{ route: "/api/verification/v1/uploads/source", maxPerWindow: 6 }]);
  });

  it("bills the SSE stream route against its own tier, not the submission or general-read budget", async () => {
    const { guard, context, seen } = guardFor("/api/verification/v1/verifications/:job_id/events");
    await guard.canActivate(context);
    expect(seen).toEqual([{ route: "/api/verification/v1/verifications/:job_id/events", maxPerWindow: 60 }]);
  });

  // Same tier, independent budgets — a client's total is their sum, not the largest.
  it("keys the counter on the route, so same-tier routes do not share one", async () => {
    const submit = guardFor("/api/verification/v1/verifications");
    const upload = guardFor("/api/verification/v1/uploads/source");
    await submit.guard.canActivate(submit.context);
    await upload.guard.canActivate(upload.context);
    expect(submit.seen[0].route).not.toBe(upload.seen[0].route);
  });

  it("answers 503 rather than 429 when checkAbuseFailOpen reports fail_closed", async () => {
    const budgets: Record<string, number> = {
      abuseMaxPerWindow: 18,
      submitAbuseMaxPerWindow: 6,
      abuseWindowMs: WINDOW_MS,
    };
    const guard = new AbuseGuard(
      { get: (key: string) => budgets[key] } as never,
      { checkAbuseFailOpen: async () => ({ allowed: false, reason: "fail_closed" }) } as never,
    );
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ ip: "203.0.113.9", route: { path: "/api/verification/v1/verifications" } }),
      }),
    } as never;

    const error = await guard.canActivate(context).then(
      () => undefined,
      (thrown: unknown) => thrown as ApiError,
    );
    expect(error?.getStatus()).toBe(503);
    expect((error?.getResponse() as { error?: string })?.error).toBe("abuse_check_unavailable");
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
        checkAbuseFailOpen: async (
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

// fingerprintIp backs the SSE per-IP concurrency ceiling (StreamConcurrencyLimiter), which tracks how many
// connections are open *right now* rather than a count over a window — so unlike fingerprintRequest, it must
// stay stable for the same address for as long as a connection might be open, not rotate with the clock.
describe("fingerprintIp", () => {
  it("produces the same fingerprint for the same address regardless of when it's called", () => {
    const req = { ip: "203.0.113.7" } as Request;
    const first = fingerprintIp(req, FINGERPRINT_KEY);
    const second = fingerprintIp(req, FINGERPRINT_KEY);

    expect(first).toBe(second);
  });

  it("produces different fingerprints for different addresses", () => {
    const a = fingerprintIp({ ip: "203.0.113.7" } as Request, FINGERPRINT_KEY);
    const b = fingerprintIp({ ip: "203.0.113.8" } as Request, FINGERPRINT_KEY);

    expect(a).not.toBe(b);
  });

  // RP-1's "not reversible" still applies even though this value is never persisted: it can appear in logs
  // (e.g. the concurrency-ceiling rejection log line), so it must not let a reader recover the address.
  it("is not the same as the raw address, and depends on the key", () => {
    const req = { ip: "203.0.113.7" } as Request;
    const fingerprint = fingerprintIp(req, FINGERPRINT_KEY);

    expect(fingerprint).not.toBe("203.0.113.7");
    expect(fingerprintIp(req, "a-different-key")).not.toBe(fingerprint);
  });

  // No window bound into this fingerprint means it never expires the way fingerprintRequest's does: were an
  // unresolvable address to collapse onto a shared literal (e.g. "unknown"), every such caller would pile into
  // one bucket for as long as any one of their connections stayed open (up to the 15-minute stream window),
  // not a 60-second rate-limit window. So an unresolvable address must not fingerprint into a shared value at
  // all — it must signal "no identity", not "the identity 'unknown'".
  it("returns null when neither req.ip nor the socket address is available, rather than fingerprinting a shared literal", () => {
    const req = { ip: undefined, socket: { remoteAddress: undefined } } as unknown as Request;

    expect(fingerprintIp(req, FINGERPRINT_KEY)).toBeNull();
  });
});
