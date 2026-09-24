import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type JobModule = typeof import("../../support/job.js");

const RETRY_INTERVAL_MS = 600;

/**
 * Each job's published statuses, in order, with how many reads each answers; the last answers every read after.
 * Counting reads rather than time keeps the sequence independent of how fast the poll loop is scheduled.
 */
const TIMELINES: Record<string, readonly (readonly [status: string, reads: number])[]> = {
  // A retryable failure the scan re-queues inside one settle window, then the verdict.
  retried: [["queued", 1], ["build_failed", 2], ["queued", 1], ["verified", 0]],
  permanent: [["queued", 1], ["build_failed", 0]],
};

function statusAt(timeline: (typeof TIMELINES)[string], read: number): string {
  let until = 0;
  for (const [status, reads] of timeline) {
    until += reads;
    if (read < until || reads === 0) return status;
  }
  return timeline[timeline.length - 1][0];
}

describe("E2E harness waiting for a terminal state", () => {
  const submitted = new Map<string, { timeline: string; reads: number }>();
  let server: Server;
  let job: JobModule;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "POST") {
        let raw = "";
        request.on("data", (chunk) => (raw += chunk));
        request.on("end", () => {
          const timeline = JSON.parse(raw).target.contract_id as string;
          const jobId = `${timeline}-${submitted.size}`;
          submitted.set(jobId, { timeline, reads: 0 });
          send(202, { status: "queued", job_id: jobId });
        });
        return;
      }
      const jobId = request.url!.split("/").pop()!;
      const entry = submitted.get(jobId);
      if (!entry) return send(404, { error: "not_found" });
      send(200, { job_id: jobId, status: statusAt(TIMELINES[entry.timeline], entry.reads++) });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    // `env.ts` reads these once, at import, so they are set before the first import below.
    delete process.env.SCVS_E2E_ENV;
    process.env.SCVS_E2E_VERIFY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.SCVS_E2E_POLL_INTERVAL_MS = "20";
    process.env.SCVS_E2E_JOB_RETRY_INTERVAL_MS = String(RETRY_INTERVAL_MS);
    job = await import("../../support/job.js");
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const submission = (timeline: keyof typeof TIMELINES) => ({
    target: { network: "testnet" as const, contract_id: timeline },
  });

  it("takes the settle window from the deployment's retry interval", () => {
    expect(job.RETRYABLE_SETTLE_MS).toBe(RETRY_INTERVAL_MS + 2_000);
  });

  it("reads a job the retry scan re-queues at its verdict, by default", async () => {
    const run = await job.submitAndWait(submission("retried"));

    expect(run.body.status).toBe("verified");
    expect(run.statusSequence).toEqual(["queued", "build_failed", "queued", "verified"]);
  });

  it("returns the first terminal state when settling is turned off", async () => {
    const run = await job.submitAndWait(submission("retried"), { settleMs: 0 });

    expect(run.body.status).toBe("build_failed");
    expect(run.statusSequence).toEqual(["queued", "build_failed"]);
  });

  it("returns a failure the scan leaves alone once one scan has passed", async () => {
    const started = Date.now();
    const run = await job.submitAndWait(submission("permanent"));

    expect(run.body.status).toBe("build_failed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(job.RETRYABLE_SETTLE_MS);
    // Measured to the first sighting, so the settle window never reads as build time.
    expect(run.wallClockMs).toBeLessThan(job.RETRYABLE_SETTLE_MS);
  });
});
