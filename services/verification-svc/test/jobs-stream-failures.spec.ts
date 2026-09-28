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

function failingAfterFirstRead(jobId: string) {
  let reads = 0;
  return {
    getJobById: async () => {
      reads += 1;
      if (reads === 1) return queuedJob(jobId);
      throw new Error("Connection terminated unexpectedly");
    },
  } as never;
}

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

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForEnd(stream: ReturnType<typeof openStream>): Promise<void> {
  await Promise.race([stream.ended, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  await nextMacrotask();
}

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

// Jest fails the running test on an unhandled rejection; a `process.on("unhandledRejection")` here never fires.
describe("JobsService.streamJob when a read fails after the stream opened", () => {
  it("ends the response for a reconnect when the read a NOTIFY triggers rejects", async () => {
    const jobId = randomUUID();
    const { jobEvents, notify } = capturingJobEvents();
    const service = new JobsService(fakeConfig(), failingAfterFirstRead(jobId), jobEvents);

    const stream = openStream(service, jobId);
    await nextMacrotask();
    expect(stream.events[0]?.data).toMatchObject({ job_id: jobId, status: "queued" });

    notify(jobId);
    await waitForEnd(stream);
    stream.close();

    expect(stream.isCompleted()).toBe(true);
    expect(stream.events.at(-1)?.data).toMatchObject({ job_id: jobId, status: "queued", stream_timeout: true });
  });

  it("ends the response for a reconnect when the safety poll's read rejects", async () => {
    const jobId = randomUUID();
    const service = new JobsService(
      fakeConfig({ jobStreamSafetyPollMs: 5 }),
      failingAfterFirstRead(jobId),
      capturingJobEvents().jobEvents,
    );

    const stream = openStream(service, jobId);
    await waitForEnd(stream);
    stream.close();

    expect(stream.isCompleted()).toBe(true);
    expect(stream.events.at(-1)?.data).toMatchObject({ job_id: jobId, status: "queued", stream_timeout: true });
  });

  it("ends the response for a reconnect when the window-expiry read rejects", async () => {
    const jobId = randomUUID();
    const service = new JobsService(
      fakeConfig({ jobStreamWindowMs: 5 }),
      failingAfterFirstRead(jobId),
      capturingJobEvents().jobEvents,
    );

    const stream = openStream(service, jobId);
    await waitForEnd(stream);
    stream.close();

    expect(stream.isCompleted()).toBe(true);
    expect(stream.events.at(-1)?.data).toMatchObject({ job_id: jobId, status: "queued", stream_timeout: true });
  });

  it("stays open when a NOTIFY read rejects while the first read is still in flight", async () => {
    const jobId = randomUUID();
    let reads = 0;
    let releaseFirstRead!: (job: JobRecord) => void;
    const firstRead = new Promise<JobRecord>((resolve) => (releaseFirstRead = resolve));
    const jobs = {
      getJobById: async () => {
        reads += 1;
        if (reads === 1) return firstRead;
        if (reads === 2) throw new Error("Connection terminated unexpectedly");
        return queuedJob(jobId);
      },
    } as never;
    const { jobEvents, notify } = capturingJobEvents();
    const service = new JobsService(fakeConfig(), jobs, jobEvents);

    const stream = openStream(service, jobId);
    await nextMacrotask();
    notify(jobId);
    await nextMacrotask();
    expect(reads).toBe(2);

    releaseFirstRead(queuedJob(jobId));
    await nextMacrotask();
    stream.close();

    expect(stream.isCompleted()).toBe(false);
    expect(stream.events.map((event) => event.data)).toEqual([expect.objectContaining({ status: "queued" })]);
    expect(stream.events[0]?.data).not.toHaveProperty("stream_timeout");
  });
});

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
