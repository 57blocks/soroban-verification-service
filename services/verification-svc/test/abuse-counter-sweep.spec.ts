import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { AbuseControlRepository, createPrismaClient, readDbEnv } from "@scvs/db";
import { fingerprintRequest } from "../src/common/abuse-guard.js";
import { AbuseControlSweepScheduler } from "../src/modules/abuse-control-sweep/abuse-control-sweep.scheduler.js";

const prisma = createPrismaClient(readDbEnv());
const abuseControl = new AbuseControlRepository(prisma);

const ROUTE = "/api/verification/v1/verifications";
const WINDOW_MS = 60_000;
const RETENTION_MS = 15 * 60_000;

/** Far enough in the past that no other suite's rows sit near it, so the sweep's cutoff cannot reach them. */
const OLD_WINDOW = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));
const FRESH_WINDOW = new Date(Date.UTC(2020, 0, 1, 1, 0, 0));
const SWEEP_AT = FRESH_WINDOW.getTime() + RETENTION_MS;

const ownedFingerprints: string[] = [];

function newFingerprint(windowStart: Date): string {
  const value = fingerprintRequest(
    { ip: `sweep-client-${randomUUID()}` } as Request,
    windowStart,
    process.env.SCVS_ABUSE_FINGERPRINT_KEY as string,
  );
  ownedFingerprints.push(value);
  return value;
}

const scheduler = new AbuseControlSweepScheduler(abuseControl, {
  get: () => RETENTION_MS,
} as never);

afterAll(async () => {
  try {
    await prisma.abuseControl.deleteMany({
      where: { submitterFingerprint: { in: ownedFingerprints } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

describe("abuse counter retention", () => {
  it("deletes a counter whose window closed outside the retention period", async () => {
    const stale = newFingerprint(OLD_WINDOW);
    await abuseControl.incrementAbuseCounter(stale, ROUTE, OLD_WINDOW);
    expect(await abuseControl.getAbuseCount(stale, ROUTE, OLD_WINDOW)).toBe(1);

    await abuseControl.pruneCountersBefore(new Date(SWEEP_AT - RETENTION_MS));

    expect(await abuseControl.getAbuseCount(stale, ROUTE, OLD_WINDOW)).toBe(0);
  });

  it("keeps a counter still inside it, so a live window is never zeroed mid-flight", async () => {
    const live = newFingerprint(FRESH_WINDOW);
    await abuseControl.incrementAbuseCounter(live, ROUTE, FRESH_WINDOW);

    await abuseControl.pruneCountersBefore(new Date(SWEEP_AT - RETENTION_MS));

    expect(await abuseControl.getAbuseCount(live, ROUTE, FRESH_WINDOW)).toBe(1);
  });

  it("runs from the scheduler against the configured retention period", async () => {
    const stale = newFingerprint(OLD_WINDOW);
    const live = newFingerprint(FRESH_WINDOW);
    await abuseControl.incrementAbuseCounter(stale, ROUTE, OLD_WINDOW);
    await abuseControl.incrementAbuseCounter(live, ROUTE, FRESH_WINDOW);

    const realNow = Date.now;
    Date.now = () => SWEEP_AT;
    try {
      await scheduler.handleSweep();
    } finally {
      Date.now = realNow;
    }

    expect(await abuseControl.getAbuseCount(stale, ROUTE, OLD_WINDOW)).toBe(0);
    expect(await abuseControl.getAbuseCount(live, ROUTE, FRESH_WINDOW)).toBe(1);
  });

  it("keeps the retention period well inside counsel's 24-hour bound and above the window", async () => {
    const { default: configuration } = await import("../src/config/configuration.js");
    const { abuseCounterRetentionMs, abuseWindowMs } = configuration();

    expect(abuseCounterRetentionMs).toBeLessThan(24 * 60 * 60_000);
    expect(abuseCounterRetentionMs).toBeGreaterThan(abuseWindowMs);
    expect(abuseWindowMs).toBe(WINDOW_MS);
  });
});
