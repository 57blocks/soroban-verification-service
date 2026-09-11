import { jest } from "@jest/globals";
import type { JobsRepository, PrunableJobRecord } from "@scvs/db";

/**
 * RP-3's scheduler half, with no database: the sweep is table-wide by design and ADR-015 forbids a suite to
 * run one against the shared Postgres. What is left to prove is its own logic — the cutoff it computes, the
 * batch it asks for, and the ordering that keeps a build log from outliving the row pointing at it.
 */
const deleteObject = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.unstable_mockModule("@scvs/aws", () => ({
  createS3Client: () => ({}),
  deleteObject,
}));

const { JobRetentionScheduler } = await import("../src/modules/scheduler/job-retention.scheduler.js");

const RETENTION_MS = 30 * 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 8, 0, 0, 0);
const CONFIG: Record<string, unknown> = {
  jobRetentionMs: RETENTION_MS,
  jobRetentionBatchSize: 500,
  stagingStorage: { bucket: "sv-test-scratch", region: "ap-southeast-2" },
};

function schedulerOver(candidates: PrunableJobRecord[]) {
  const listPrunableJobs = jest.fn<(opts: { before: Date; limit: number }) => Promise<PrunableJobRecord[]>>();
  const pruneJobs = jest.fn<(ids: string[]) => Promise<number>>();
  listPrunableJobs.mockResolvedValue(candidates);
  pruneJobs.mockImplementation(async (ids) => ids.length);
  const jobs = { listPrunableJobs, pruneJobs } as unknown as JobsRepository;
  const scheduler = new JobRetentionScheduler(jobs, { get: (key: string) => CONFIG[key] } as never);
  return { scheduler, listPrunableJobs, pruneJobs };
}

beforeEach(() => {
  deleteObject.mockReset();
  deleteObject.mockResolvedValue(undefined);
});

describe("JobRetentionScheduler", () => {
  it("asks for jobs older than the configured period, in one bounded batch", async () => {
    const { scheduler, listPrunableJobs } = schedulerOver([]);

    await scheduler.sweep(NOW);

    expect(listPrunableJobs).toHaveBeenCalledWith({
      before: new Date(NOW - RETENTION_MS),
      limit: 500,
    });
  });

  it("deletes nothing and touches no bucket when there is nothing old enough", async () => {
    const { scheduler, pruneJobs } = schedulerOver([]);

    expect(await scheduler.sweep(NOW)).toBe(0);
    expect(pruneJobs).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("removes a job's build log before the row that points at it", async () => {
    const { scheduler, pruneJobs } = schedulerOver([
      { jobId: "job-with-log", buildLogObjectKey: "build-logs/rebuild-1/build.log" },
      { jobId: "job-without-log" },
    ]);

    expect(await scheduler.sweep(NOW)).toBe(2);
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith({}, "sv-test-scratch", "build-logs/rebuild-1/build.log");
    expect(pruneJobs).toHaveBeenCalledWith(["job-with-log", "job-without-log"]);
  });

  // `build_log_object_key` is the only pointer to that object: deleting the row first would retain the log
  // forever AND lose every way to reach it.
  it("keeps the row when its build log could not be deleted, and prunes the rest", async () => {
    deleteObject.mockRejectedValueOnce(new Error("AccessDenied"));
    const { scheduler, pruneJobs } = schedulerOver([
      { jobId: "undeletable-log", buildLogObjectKey: "build-logs/rebuild-2/build.log" },
      { jobId: "clean" },
    ]);

    expect(await scheduler.sweep(NOW)).toBe(1);
    expect(pruneJobs).toHaveBeenCalledWith(["clean"]);
  });

  it("survives a failing scan rather than taking the scheduler down with it", async () => {
    const { scheduler, listPrunableJobs } = schedulerOver([]);
    listPrunableJobs.mockRejectedValueOnce(new Error("connection reset"));

    await expect(scheduler.sweep(NOW)).resolves.toBe(0);
  });
});
