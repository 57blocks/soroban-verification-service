import { jest } from "@jest/globals";
import { ScvsLogger } from "@scvs/core";
import { BatchEventHandlerService } from "../src/modules/batch-events/batch-event-handler.service.js";

const JOB_ID = "b1f0c9a2-0000-4000-8000-000000000001";

const batchEvent = (over: Record<string, unknown> = {}) => ({
  "detail-type": "Batch Job State Change",
  source: "aws.batch",
  detail: { jobId: JOB_ID, status: "FAILED", statusReason: "Essential container in job exited", ...over },
});

function router() {
  const getRebuild = jest.fn<(id: string) => Promise<unknown>>();
  const getEnvironment = jest.fn<(id: string) => Promise<unknown>>();
  const recordRebuild = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  const recordEnvironment = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  getRebuild.mockResolvedValue(undefined);
  getEnvironment.mockResolvedValue(undefined);
  recordRebuild.mockResolvedValue(undefined);
  recordEnvironment.mockResolvedValue(undefined);

  const handler = new BatchEventHandlerService(
    { getByBatchJobId: getRebuild } as never,
    { recordFromBatchTerminalState: recordRebuild } as never,
    { getByBatchJobId: getEnvironment } as never,
    { recordFromBatchTerminalState: recordEnvironment } as never,
  );
  return { handler, getRebuild, getEnvironment, recordRebuild, recordEnvironment };
}

/** Spies on the logger prototype: patching `process.stdout` fights jest's per-test output capture. */
function warnings(): { calls: string[] } {
  const captured: string[] = [];
  jest
    .spyOn(ScvsLogger.prototype, "warn")
    .mockImplementation((message: string, fields?: Record<string, unknown>) => {
      captured.push(`${message} ${JSON.stringify(fields ?? {})}`);
    });
  return { calls: captured };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("a Batch job the tracking rebuild is still waiting on", () => {
  it("is recorded against that rebuild, with the parsed event", async () => {
    const { handler, getRebuild, recordRebuild } = router();
    const rebuild = { rebuildId: "r-1", status: "running" };
    getRebuild.mockResolvedValue(rebuild);

    await handler.onBatchJobStateChangeEvent(batchEvent());

    expect(recordRebuild).toHaveBeenCalledTimes(1);
    expect(recordRebuild).toHaveBeenCalledWith(rebuild, {
      jobId: JOB_ID,
      status: "FAILED",
      statusReason: "Essential container in job exited",
    });
  });

  it("is ignored when that rebuild is already terminal — Batch redelivers", async () => {
    const { handler, getRebuild, recordRebuild } = router();
    getRebuild.mockResolvedValue({ rebuildId: "r-1", status: "done", outcome: "success" });

    await handler.onBatchJobStateChangeEvent(batchEvent());

    expect(recordRebuild).not.toHaveBeenCalled();
  });
});

describe("a Batch job no rebuild is tracking", () => {
  it("goes to the composition that is tracking it, not to a rebuild", async () => {
    const { handler, getEnvironment, recordEnvironment, recordRebuild } = router();
    const environment = { environmentId: "env-1", status: "composing" };
    getEnvironment.mockResolvedValue(environment);

    await handler.onBatchJobStateChangeEvent(batchEvent({ status: "SUCCEEDED" }));

    expect(recordEnvironment).toHaveBeenCalledTimes(1);
    expect(recordEnvironment).toHaveBeenCalledWith(environment, {
      jobId: JOB_ID,
      status: "SUCCEEDED",
      statusReason: "Essential container in job exited",
    });
    expect(recordRebuild).not.toHaveBeenCalled();
  });

  it.each(["ready", "failed"])(
    "is ignored when that composition is already %s — Batch redelivers here too",
    async (status) => {
      const { handler, getEnvironment, recordEnvironment } = router();
      getEnvironment.mockResolvedValue({ environmentId: "env-1", status });

      await handler.onBatchJobStateChangeEvent(batchEvent());

      expect(recordEnvironment).not.toHaveBeenCalled();
    },
  );

  it("asks the compositions before dropping it, and only then drops it", async () => {
    const { handler, getEnvironment, recordRebuild, recordEnvironment } = router();

    const warned = warnings();

    await handler.onBatchJobStateChangeEvent(batchEvent());

    expect(getEnvironment).toHaveBeenCalledWith(JOB_ID);
    expect(recordRebuild).not.toHaveBeenCalled();
    expect(recordEnvironment).not.toHaveBeenCalled();
    expect(warned.calls.join("\n")).toContain("no rebuild is tracking this Batch job");
  });
});

describe("an event this build cannot parse", () => {
  it.each([
    ["not an object", "a string"],
    ["no detail", { "detail-type": "Batch Job State Change" }],
    ["detail without a jobId", { detail: { status: "FAILED" } }],
    ["detail without a status", { detail: { jobId: JOB_ID } }],
    ["a non-string jobId", { detail: { jobId: 7, status: "FAILED" } }],
  ])("is ignored rather than recorded (%s)", async (_case, raw) => {
    const { handler, getRebuild, recordRebuild, recordEnvironment } = router();

    await handler.onBatchJobStateChangeEvent(raw);

    expect(getRebuild).not.toHaveBeenCalled();
    expect(recordRebuild).not.toHaveBeenCalled();
    expect(recordEnvironment).not.toHaveBeenCalled();
  });

  it("never echoes the event, which carries the job's presigned upload URL", async () => {
    const { handler } = router();
    const secret = "https://sv-staging.s3.amazonaws.com/x?X-Amz-Signature=deadbeefdeadbeefdeadbeef";
    const raw = {
      "detail-type": "Batch Job State Change",
      detail: {
        container: {
          environment: [{ name: "SCVS_JOB_PARAMS_JSON", value: JSON.stringify({ artifact_upload_url: secret }) }],
        },
      },
    };

    const warned = warnings();

    await handler.onBatchJobStateChangeEvent(raw);

    const logs = warned.calls.join("\n");
    expect(logs).toContain("could not parse Batch event");
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain("X-Amz-Signature");
    expect(logs).not.toContain("SCVS_JOB_PARAMS_JSON");
  });

  it("summarises the shape without listing every key of a wide event", async () => {
    const { handler } = router();
    const wide: Record<string, unknown> = { "detail-type": "Something Else" };
    for (let i = 0; i < 20; i += 1) wide[`k${i}`] = i;

    const warned = warnings();

    await handler.onBatchJobStateChangeEvent(wide);

    const logs = warned.calls.join("\n");
    expect(logs).toContain("Something Else");
    const described = /keys: ([^"\\]*)/.exec(logs)?.[1] ?? "";
    expect(described.split(",").length).toBeLessThanOrEqual(8);
  });
});
