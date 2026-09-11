import { jest } from "@jest/globals";
import type { JobsRepository } from "@scvs/db";

/**
 * The sweep's own logic, with no database: it deletes table-wide, and ADR-015 forbids a suite to run one
 * against the shared Postgres. What is left to prove is that the bytes go before the pointer does, and that
 * a failed delete keeps both.
 */
const deleteObject = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.unstable_mockModule("@scvs/aws", () => ({
  createS3Client: () => ({}),
  deleteObject,
}));

const { BuildLogExpiryScheduler } = await import(
  "../src/modules/scheduler/build-log-expiry.scheduler.js"
);

const NOW = Date.UTC(2026, 8, 8, 0, 0, 0);
const CONFIG: Record<string, unknown> = {
  buildLogSweepBatchSize: 200,
  stagingStorage: { bucket: "sv-test-scratch", region: "ap-southeast-2" },
};

function schedulerOver(keys: string[]) {
  const order: string[] = [];
  const listExpiredBuildLogs = jest.fn<(now: Date, limit: number) => Promise<string[]>>();
  const clearBuildLogKey = jest.fn<(key: string) => Promise<number>>();
  listExpiredBuildLogs.mockResolvedValue(keys);
  clearBuildLogKey.mockImplementation(async (key) => {
    order.push(`clear:${key}`);
    return 1;
  });
  deleteObject.mockImplementation(async (_client, _bucket, key) => {
    order.push(`delete:${key}`);
  });
  const jobs = { listExpiredBuildLogs, clearBuildLogKey } as unknown as JobsRepository;
  const scheduler = new BuildLogExpiryScheduler(jobs, { get: (k: string) => CONFIG[k] } as never);
  return { scheduler, listExpiredBuildLogs, clearBuildLogKey, order };
}

beforeEach(() => {
  deleteObject.mockReset();
  deleteObject.mockResolvedValue(undefined);
});

describe("BuildLogExpiryScheduler", () => {
  it("asks for expired objects in one bounded batch", async () => {
    const { scheduler, listExpiredBuildLogs } = schedulerOver([]);

    await scheduler.sweep(NOW);

    expect(listExpiredBuildLogs).toHaveBeenCalledWith(new Date(NOW), 200);
  });

  it("touches no bucket when nothing has expired", async () => {
    const { scheduler, clearBuildLogKey } = schedulerOver([]);

    expect(await scheduler.sweep(NOW)).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(clearBuildLogKey).not.toHaveBeenCalled();
  });

  it("★ deletes the bytes before clearing the pointer that finds them", async () => {
    const { scheduler, order } = schedulerOver(["build-logs/a/build.log"]);

    expect(await scheduler.sweep(NOW)).toBe(1);
    // The reverse order would leave an object nothing points at — retained, and unreachable for deletion.
    expect(order).toEqual(["delete:build-logs/a/build.log", "clear:build-logs/a/build.log"]);
  });

  it("★ keeps the pointer when the delete fails, and carries on with the rest", async () => {
    const { scheduler, clearBuildLogKey } = schedulerOver([
      "build-logs/undeletable/build.log",
      "build-logs/fine/build.log",
    ]);
    deleteObject.mockImplementationOnce(async () => {
      throw new Error("AccessDenied");
    });

    expect(await scheduler.sweep(NOW)).toBe(1);
    expect(clearBuildLogKey).toHaveBeenCalledTimes(1);
    expect(clearBuildLogKey).toHaveBeenCalledWith("build-logs/fine/build.log");
  });

  it("survives a failing scan rather than taking the scheduler down", async () => {
    const { scheduler, listExpiredBuildLogs } = schedulerOver([]);
    listExpiredBuildLogs.mockRejectedValueOnce(new Error("connection reset"));

    await expect(scheduler.sweep(NOW)).resolves.toBe(0);
  });

  it("keeps the retention default at counsel's 7 days", async () => {
    const { default: configuration } = await import("../src/config/configuration.js");

    expect(configuration().buildLogRetentionMs).toBe(7 * 24 * 60 * 60_000);
  });
});
