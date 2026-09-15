import { randomUUID } from "node:crypto";
import type { MessageEvent } from "@nestjs/common";
import type { JobRecord } from "@scvs/db";
import { JobsService, StreamConcurrencyLimiter } from "../src/modules/verifications/jobs.service.js";

/**
 * An SSE connection holds a socket, a setInterval, and a subscribeToJobUpdates listener open for up to
 * jobStreamWindowMs without ever issuing a second request, so a rate limit on connection setup cannot bound
 * how many stay open at once. These specs cover the concurrency ceiling that does.
 */

function fakeConfig(overrides: Record<string, number> = {}) {
  const values: Record<string, number> = {
    jobStreamSafetyPollMs: 10_000,
    jobStreamWindowMs: 15 * 60_000,
    jobMaxWaitMs: 60 * 60_000,
    jobStreamMaxConnectionsPerJob: 5,
    jobStreamMaxConnectionsTotal: 500,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as never;
}

function fakeJobRecord(jobId: string): JobRecord {
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

function fakeJobsRepository(jobId: string) {
  return { getJobById: async () => fakeJobRecord(jobId) } as never;
}

/** Never fires NOTIFY on its own — these specs drive the ceiling, not the push path. */
function fakeJobEvents() {
  return { subscribeToJobUpdates: async () => () => {} } as never;
}

/** Lets queued microtasks (the `loadJobBody` await inside `emitCurrent`) settle before assertions run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Subscribes and hands back a handle to read emissions and unsubscribe (closing the SSE connection). */
function openStream(service: JobsService, jobId: string) {
  const events: MessageEvent[] = [];
  let completed = false;
  const subscription = service.streamJob(jobId).subscribe({
    next: (event) => events.push(event),
    complete: () => {
      completed = true;
    },
  });
  return {
    events,
    isCompleted: () => completed,
    close: () => subscription.unsubscribe(),
  };
}

describe("StreamConcurrencyLimiter", () => {
  it("admits up to the per-job ceiling and refuses the next acquire for that job", () => {
    const limiter = new StreamConcurrencyLimiter();
    const jobId = randomUUID();
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.tryAcquire(jobId, 5, 500)).toBe(true);
    }
    expect(limiter.tryAcquire(jobId, 5, 500)).toBe(false);
  });

  it("releasing one slot admits exactly one more", () => {
    const limiter = new StreamConcurrencyLimiter();
    const jobId = randomUUID();
    for (let i = 0; i < 5; i += 1) expect(limiter.tryAcquire(jobId, 5, 500)).toBe(true);
    expect(limiter.tryAcquire(jobId, 5, 500)).toBe(false);

    limiter.release(jobId);
    expect(limiter.tryAcquire(jobId, 5, 500)).toBe(true);
    expect(limiter.tryAcquire(jobId, 5, 500)).toBe(false);
  });

  it("enforces the process-wide total across many distinct job ids", () => {
    const limiter = new StreamConcurrencyLimiter();
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.tryAcquire(randomUUID(), 5, 3)).toBe(true);
    }
    // A fourth job, well under its own per-job ceiling, still hits the process-wide ceiling.
    expect(limiter.tryAcquire(randomUUID(), 5, 3)).toBe(false);
  });

  it("release() on a job with no held slots is a no-op, not a negative count", () => {
    const limiter = new StreamConcurrencyLimiter();
    const jobId = randomUUID();
    limiter.release(jobId);
    // Still able to fill the full ceiling afterwards — release() never went negative and inflated capacity.
    for (let i = 0; i < 5; i += 1) expect(limiter.tryAcquire(jobId, 5, 5)).toBe(true);
    expect(limiter.tryAcquire(jobId, 5, 5)).toBe(false);
  });
});

describe("JobsService.streamJob concurrency ceiling", () => {
  it("rejects a new connection once a job is at its per-job ceiling, and does not consume a slot for it", async () => {
    const jobId = randomUUID();
    const service = new JobsService(fakeConfig({ jobStreamMaxConnectionsPerJob: 2 }), fakeJobsRepository(jobId), fakeJobEvents());

    const first = openStream(service, jobId);
    const second = openStream(service, jobId);
    await flushMicrotasks();

    const third = openStream(service, jobId);
    await flushMicrotasks();

    expect(third.isCompleted()).toBe(true);
    expect(third.events[0]?.data).toMatchObject({ error: "stream_connection_limit_reached", status_code: 429 });

    first.close();
    second.close();
    third.close();
  });

  it("releases a slot on client disconnect, letting a subsequent connection through", async () => {
    const jobId = randomUUID();
    const service = new JobsService(fakeConfig({ jobStreamMaxConnectionsPerJob: 1 }), fakeJobsRepository(jobId), fakeJobEvents());

    const first = openStream(service, jobId);
    await flushMicrotasks();

    const rejected = openStream(service, jobId);
    await flushMicrotasks();
    expect(rejected.isCompleted()).toBe(true);
    expect(rejected.events[0]?.data).toMatchObject({ error: "stream_connection_limit_reached" });

    // Client disconnects — RxJS teardown must release the slot back to the limiter.
    first.close();

    const afterDisconnect = openStream(service, jobId);
    await flushMicrotasks();
    expect(afterDisconnect.isCompleted()).toBe(false);
    expect(afterDisconnect.events[0]?.data).toMatchObject({ job_id: jobId, status: "queued" });

    afterDisconnect.close();
  });

  it("keeps two different jobs' ceilings independent", async () => {
    const jobA = randomUUID();
    const jobB = randomUUID();
    const jobsRepository = {
      getJobById: async (id: string) => fakeJobRecord(id),
    } as never;
    const service = new JobsService(fakeConfig({ jobStreamMaxConnectionsPerJob: 1 }), jobsRepository, fakeJobEvents());

    const streamA = openStream(service, jobA);
    await flushMicrotasks();
    const streamB = openStream(service, jobB);
    await flushMicrotasks();

    expect(streamA.isCompleted()).toBe(false);
    expect(streamB.isCompleted()).toBe(false);

    streamA.close();
    streamB.close();
  });

  it("releases the slot when subscribeToJobUpdates rejects", async () => {
    const jobId = randomUUID();
    let attempt = 0;
    const jobEvents = {
      subscribeToJobUpdates: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("connection refused");
        return () => {};
      },
    } as never;
    const service = new JobsService(fakeConfig({ jobStreamMaxConnectionsPerJob: 1 }), fakeJobsRepository(jobId), jobEvents);

    const first = openStream(service, jobId);
    await flushMicrotasks();
    expect(first.isCompleted()).toBe(true);
    expect(first.events[0]?.data).toMatchObject({ error: "internal_error" });

    const second = openStream(service, jobId);
    await flushMicrotasks();
    expect(second.isCompleted()).toBe(false);

    second.close();
  });
});
