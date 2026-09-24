import { randomUUID } from "node:crypto";
import type { MessageEvent } from "@nestjs/common";
import type { JobRecord } from "@scvs/db";
import { JobsService } from "../src/modules/verifications/jobs.service.js";

function fakeConfig(overrides: Record<string, number> = {}) {
  const values: Record<string, number> = {
    jobStreamSafetyPollMs: 10_000,
    jobStreamWindowMs: 15 * 60_000,
    jobMaxWaitMs: 60 * 60_000,
    jobStreamMaxConnectionsPerJob: 5,
    jobStreamMaxConnectionsPerIp: 10,
    jobStreamMaxConnectionsTotal: 500,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as never;
}

function queuedJob(jobId: string): JobRecord {
  return {
    jobId,
    status: "queued",
    failureReason: null,
    verdict: null,
    target: { network: "testnet", contract_id: "C".repeat(56) },
    verificationMode: "submitted",
    sourceRef: { type: "source_uri", visibility: "public", source_uri: "https://example.com/x.tar.gz", source_sha256: "0".repeat(64) },
    buildOptions: {},
    dryRun: false,
    buildLogHold: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as JobRecord;
}

/** Keeps the NOTIFY listener the stream registers, so a test can fire it. */
function capturingJobEvents() {
  let listener: ((jobId: string) => void) | undefined;
  const jobEvents = {
    subscribeToJobUpdates: async (registered: (jobId: string) => void) => {
      listener = registered;
      return () => {
        listener = undefined;
      };
    },
  } as never;
  return { jobEvents, notify: (jobId: string) => listener?.(jobId) };
}

function openStream(service: JobsService, jobId: string) {
  const events: MessageEvent[] = [];
  let completed = false;
  let markEnded!: () => void;
  const ended = new Promise<void>((resolve) => (markEnded = resolve));
  const subscription = service.streamJob(jobId, `ip-${randomUUID()}`).subscribe({
    next: (event) => events.push(event),
    complete: () => {
      completed = true;
      markEnded();
    },
  });
  return { events, ended, isCompleted: () => completed, close: () => subscription.unsubscribe() };
}

/** Runs every queued microtask before the test goes on. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Records every interval and timeout set while installed; `stop()` clears any left and returns their count. */
function trackTimers() {
  const real = { setInterval, clearInterval, setTimeout, clearTimeout };
  const live = new Set<unknown>();
  const track = <T>(handle: T) => {
    live.add(handle);
    return handle;
  };
  const forget = (handle: unknown) => live.delete(handle);
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) =>
    track(real.setInterval(...args))) as typeof setInterval;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) =>
    track(real.setTimeout(...args))) as typeof setTimeout;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    forget(handle);
    real.clearInterval(handle);
  }) as typeof clearInterval;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    forget(handle);
    real.clearTimeout(handle);
  }) as typeof clearTimeout;
  return {
    stop: (): number => {
      Object.assign(globalThis, real);
      const leaked = live.size;
      for (const handle of live) real.clearInterval(handle as ReturnType<typeof setInterval>);
      return leaked;
    },
  };
}

describe("JobsService.streamJob when the client disconnects during the first read", () => {
  it("leaves no interval or timeout behind", async () => {
    const jobId = randomUUID();
    let reads = 0;
    let releaseFirstRead!: (job: JobRecord) => void;
    const firstRead = new Promise<JobRecord>((resolve) => (releaseFirstRead = resolve));
    const jobs = {
      getJobById: () => {
        reads += 1;
        return firstRead;
      },
    } as never;
    const service = new JobsService(fakeConfig(), jobs, capturingJobEvents().jobEvents);

    const timers = trackTimers();
    let leaked: number;
    try {
      const stream = openStream(service, jobId);
      await nextMacrotask();
      expect(reads).toBe(1);

      stream.close();
      releaseFirstRead(queuedJob(jobId));
      await nextMacrotask();
    } finally {
      leaked = timers.stop();
    }

    expect(leaked).toBe(0);
  });
});
