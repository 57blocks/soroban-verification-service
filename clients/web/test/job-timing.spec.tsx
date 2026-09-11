import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { legalBundleFixture } from "./legal-bundle.fixture";
import { JobTimingCard } from "@/features/verification/components/JobTimingCard";

vi.mock("@scvs/verify-api-client", () => ({
  getLegalDocuments: () => Promise.resolve(legalBundleFixture()),
  usePreflightVerification: () => ({ mutateAsync: vi.fn() }),
  useSubmitVerification: () => ({ mutateAsync: vi.fn() }),
  useUploadSource: () => ({ mutateAsync: vi.fn() }),
  getBuildLog: vi.fn().mockResolvedValue({ data: "" }),
  AXIOS_INSTANCE: { defaults: {} },
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/http", () => ({
  isApiBaseConfigured: () => true,
  getApiBase: () => "",
  errorMessage: (_error: unknown, fallback: string) => fallback,
  isHttpError: () => false,
}));

const { useVerificationConsole } = await import(
  "@/features/verification/hooks/use-verification-console"
);

const JOB_ID = "fc589d78-ca50-4bcc-afe1-3a4c9d49240b";
const QUEUED_AT = "2026-08-18T05:52:30.000Z";

class DrivableEventSource {
  static readonly CLOSED = 2;
  static last: DrivableEventSource | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  constructor(readonly url: string) {
    DrivableEventSource.last = this;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = DrivableEventSource.CLOSED;
  }
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const openJob = () => {
  const rendered = renderHook(
    () => useVerificationConsole({ mode: "job", initialJobId: JOB_ID }),
    { wrapper },
  );
  const stream = DrivableEventSource.last;
  if (!stream) throw new Error("the console did not open a job stream");
  return { ...rendered, stream };
};

const emit = async (stream: DrivableEventSource, payload: unknown) => {
  await act(async () => {
    stream.emit(payload);
  });
};

const queuedEvent = {
  job_id: JOB_ID,
  status: "queued",
  created_at: QUEUED_AT,
  updated_at: "2026-08-18T05:52:31.000Z",
  target: { network: "testnet", wasm_hash: "8e".repeat(32) },
};

beforeEach(() => {
  DrivableEventSource.last = null;
  globalThis.EventSource = DrivableEventSource as unknown as typeof EventSource;
  window.localStorage.clear();
});

describe("a settled job's total time is the verifier's measurement, not this tab's", () => {
  test("is the span between the job's own created_at and updated_at", async () => {
    const { result, stream } = openJob();
    await emit(stream, queuedEvent);
    await emit(stream, {
      ...queuedEvent,
      status: "verified",
      // Four minutes twelve seconds after it was queued.
      updated_at: "2026-08-18T05:56:42.000Z",
    });

    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(false));
    expect(result.current.jobTiming?.elapsedMs).toBe(4 * 60_000 + 12_000);
    expect(result.current.jobTiming?.startedMs).toBe(Date.parse(QUEUED_AT));
  });

  /** `jobs.service.ts` synthesises `job_timeout` from `{status, reason, detail, job_id}` — no timestamps at all. */
  test("a job_timeout, which carries no timestamps, keeps the created_at already received", async () => {
    const { result, stream } = openJob();
    await emit(stream, queuedEvent);
    await emit(stream, {
      job_id: JOB_ID,
      status: "error",
      reason: "job_timeout",
      detail: 'The verification job has been "queued" for over 30 minutes.',
    });

    await waitFor(() => expect(result.current.submissionState).toBe("error"));
    expect(result.current.jobTiming?.startedMs).toBe(Date.parse(QUEUED_AT));
  });

  // A stopwatch that keeps running after the job stopped is a lie about the job.
  test("a running job is marked running; a settled one is not", async () => {
    const { result, stream } = openJob();
    await emit(stream, queuedEvent);
    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(true));

    await emit(stream, { ...queuedEvent, status: "mismatch", updated_at: "2026-08-18T05:55:00.000Z" });
    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(false));
  });
});

describe("a settled job's total does not grow when the row is written again", () => {
  test("re-opening it reports the instant it settled, not the row's latest write", async () => {
    const first = openJob();
    await emit(first.stream, queuedEvent);
    await emit(first.stream, {
      ...queuedEvent,
      status: "verified",
      updated_at: "2026-08-18T05:56:42.000Z",
    });
    await waitFor(() => expect(first.result.current.jobTiming?.isRunning).toBe(false));
    expect(first.result.current.jobTiming?.elapsedMs).toBe(4 * 60_000 + 12_000);
    first.unmount();

    // The same job, re-opened after an archive backfill wrote the row an hour later.
    const again = openJob();
    await emit(again.stream, {
      ...queuedEvent,
      status: "verified",
      updated_at: "2026-08-18T06:56:42.000Z",
    });

    await waitFor(() => expect(again.result.current.jobTiming?.isRunning).toBe(false));
    expect(again.result.current.jobTiming?.elapsedMs).toBe(4 * 60_000 + 12_000);
    // The third tile agrees with the total rather than contradicting it.
    expect(again.result.current.jobTiming?.updatedMs).toBe(
      Date.parse("2026-08-18T05:56:42.000Z"),
    );
  });

  // Reached only by a terminal event whose result carries no `verified_at` — every arm that writes a result
  // writes one, so this is the "no result at all" case.
  test("a job first opened already-settled, with no result, falls back to updated_at", async () => {
    const { result, stream } = openJob();
    await emit(stream, {
      ...queuedEvent,
      status: "verified",
      updated_at: "2026-08-18T06:56:42.000Z",
    });

    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(false));
    expect(result.current.jobTiming?.elapsedMs).toBe(64 * 60_000 + 12_000);
    expect(result.current.jobTiming?.finishIsExact).toBe(false);
  });
});

/** `result.verified_at` is written in the same `advanceJob` call as the terminal status and never rewritten. */
describe("a settled job's total comes from the server's own finish instant", () => {
  const withVerifiedAt = {
    ...queuedEvent,
    status: "verified",
    // The archive backfill's write, four hours after the verdict.
    updated_at: "2026-08-18T09:56:42.000Z",
    result: {
      status_summary: "verified",
      wasm_hash: "8e".repeat(32),
      verified_at: "2026-08-18T05:56:42.000Z",
    },
  };

  test("reads verified_at, not the row's latest write", async () => {
    const { result, stream } = openJob();
    await emit(stream, queuedEvent);
    await emit(stream, withVerifiedAt);

    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(false));
    expect(result.current.jobTiming?.elapsedMs).toBe(4 * 60_000 + 12_000);
    expect(result.current.jobTiming?.updatedMs).toBe(Date.parse("2026-08-18T05:56:42.000Z"));
    expect(result.current.jobTiming?.finishIsExact).toBe(true);
  });

  // The case the browser-local freeze could never reach: no `finished_at` of this tab's own.
  test("a shared link, opened cold, reports the same total the submitter saw", async () => {
    const { result, stream } = openJob();
    await emit(stream, withVerifiedAt);

    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(false));
    expect(result.current.jobTiming?.elapsedMs).toBe(4 * 60_000 + 12_000);
    expect(result.current.jobTiming?.finishIsExact).toBe(true);
  });

  // A mismatch is a finished verification, not an unfinished one.
  test("a mismatch's verified_at counts the same way", async () => {
    const { result, stream } = openJob();
    await emit(stream, {
      ...withVerifiedAt,
      status: "mismatch",
      result: { ...withVerifiedAt.result, status_summary: "mismatch", matched: false },
    });

    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(false));
    expect(result.current.jobTiming?.elapsedMs).toBe(4 * 60_000 + 12_000);
  });

  // While the job is moving, the third tile is "Last update" and `updated_at` is exactly that.
  test("a running job still tracks updated_at", async () => {
    const { result, stream } = openJob();
    await emit(stream, queuedEvent);

    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(true));
    expect(result.current.jobTiming?.updatedMs).toBe(Date.parse("2026-08-18T05:52:31.000Z"));
  });
});

/** `completed_at` is the job's own settling instant on every terminal path. */
describe("completed_at is what the total is measured to", () => {
  const settledAtFiveFiftySix = {
    ...queuedEvent,
    status: "verified",
    // The archive backfill's write, four hours after the verdict.
    updated_at: "2026-08-18T09:56:42.000Z",
    completed_at: "2026-08-18T05:56:42.000Z",
    result: {
      status_summary: "verified",
      wasm_hash: "8e".repeat(32),
      verified_at: "2026-08-18T05:56:42.000Z",
    },
  };

  test("a shared link, opened cold, reports an exact total from it", async () => {
    const { result, stream } = openJob();
    await emit(stream, settledAtFiveFiftySix);

    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(false));
    expect(result.current.jobTiming?.elapsedMs).toBe(4 * 60_000 + 12_000);
    expect(result.current.jobTiming?.updatedMs).toBe(Date.parse("2026-08-18T05:56:42.000Z"));
    expect(result.current.jobTiming?.finishIsExact).toBe(true);
  });

  // A dry run is terminal with a real verdict and no `verified_at`.
  test("a dry run, which has no verified_at, still reports an exact total", async () => {
    const { result, stream } = openJob();
    await emit(stream, queuedEvent);
    await emit(stream, {
      ...queuedEvent,
      status: "verified",
      updated_at: "2026-08-18T09:56:42.000Z",
      completed_at: "2026-08-18T05:56:42.000Z",
      result: { status_summary: "verified", wasm_hash: "8e".repeat(32), matched: true },
    });

    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(false));
    expect(result.current.jobTiming?.elapsedMs).toBe(4 * 60_000 + 12_000);
    expect(result.current.jobTiming?.finishIsExact).toBe(true);
  });

  // An adopted verdict settles in seconds against a publication from last week, so its `verified_at` is the
  // donor's and precedes this job's own `created_at`.
  test("an adopted verdict is measured to its own completion, not the donor's", async () => {
    const { result, stream } = openJob();
    await emit(stream, {
      ...queuedEvent,
      status: "verified",
      updated_at: "2026-08-18T05:52:45.000Z",
      completed_at: "2026-08-18T05:52:45.000Z",
      result: {
        status_summary: "verified",
        wasm_hash: "8e".repeat(32),
        // A week before this job existed.
        verified_at: "2026-08-11T00:00:00.000Z",
      },
    });

    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(false));
    // Submitted 05:52:30, adopted 05:52:45. Not "0s", and not a week.
    expect(result.current.jobTiming?.elapsedMs).toBe(15_000);
    expect(result.current.jobTiming?.updatedMs).toBe(Date.parse("2026-08-18T05:52:45.000Z"));
    expect(result.current.jobTiming?.finishIsExact).toBe(true);
  });

  // Such a candidate is now discarded rather than clamped.
  test("a donor instant older than the job is discarded, not clamped to zero", async () => {
    const { result, stream } = openJob();
    await emit(stream, {
      ...queuedEvent,
      status: "verified",
      updated_at: "2026-08-18T05:52:45.000Z",
      result: {
        status_summary: "verified",
        wasm_hash: "8e".repeat(32),
        verified_at: "2026-08-11T00:00:00.000Z",
      },
    });

    await waitFor(() => expect(result.current.jobTiming?.isRunning).toBe(false));
    expect(result.current.jobTiming?.elapsedMs).not.toBe(0);
    expect(result.current.jobTiming?.elapsedMs).toBe(15_000);
    expect(result.current.jobTiming?.finishIsExact).toBe(false);
  });
});

/** A job that took four minutes last week then reported however long ago it had been submitted. */
describe("the recent-jobs entry records the verifier's timestamps", () => {
  test("re-opening a finished job does not stretch its recorded duration", async () => {
    const { result, stream } = openJob();
    await emit(stream, queuedEvent);
    await emit(stream, {
      ...queuedEvent,
      status: "verified",
      updated_at: "2026-08-18T05:56:42.000Z",
    });

    await waitFor(() => expect(result.current.recentJobs).toHaveLength(1));
    const stored = result.current.recentJobs[0];
    expect(stored.created_at).toBe(QUEUED_AT);
    expect(stored.updated_at).toBe("2026-08-18T05:56:42.000Z");
    expect(stored.finished_at).toBe("2026-08-18T05:56:42.000Z");
  });

  // Write-once, like `created_at` — and for a stronger reason: a later `updated_at` is not a later finish, it
  // is a later write to a row that already finished.
  test("a later write to the settled row does not move the recorded finish", async () => {
    const first = openJob();
    await emit(first.stream, queuedEvent);
    await emit(first.stream, {
      ...queuedEvent,
      status: "verified",
      updated_at: "2026-08-18T05:56:42.000Z",
    });
    await waitFor(() => expect(first.result.current.recentJobs).toHaveLength(1));
    first.unmount();

    const again = openJob();
    await emit(again.stream, {
      ...queuedEvent,
      status: "verified",
      updated_at: "2026-08-18T06:56:42.000Z",
    });

    await waitFor(() => expect(again.result.current.recentJobs).toHaveLength(1));
    expect(again.result.current.recentJobs[0].finished_at).toBe("2026-08-18T05:56:42.000Z");
  });
});

describe("the timing card", () => {
  afterEach(() => vi.useRealTimers());

  test("renders nothing when the job carried no usable timestamp", () => {
    const { container } = render(<JobTimingCard timing={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("a settled job reads as a total, with the instant it finished", () => {
    render(
      <JobTimingCard
        timing={{
          startedMs: Date.parse(QUEUED_AT),
          updatedMs: Date.parse("2026-08-18T05:56:42.000Z"),
          elapsedMs: 4 * 60_000 + 12_000,
          isRunning: false,
          finishIsExact: true,
        }}
      />,
    );

    expect(screen.getByText("Total time")).toBeInTheDocument();
    expect(screen.getByTestId("job-timing-elapsed")).toHaveTextContent("4m 12s");
    expect(screen.getByText("Finished at")).toBeInTheDocument();
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
  });

  // An `updated_at`-derived total is an upper bound, and must not read as the verifier's measurement.
  test("marks the total approximate when it did not come from verified_at", () => {
    render(
      <JobTimingCard
        timing={{
          startedMs: Date.parse(QUEUED_AT),
          updatedMs: Date.parse("2026-08-18T06:56:42.000Z"),
          elapsedMs: 64 * 60_000 + 12_000,
          isRunning: false,
        }}
      />,
    );

    expect(screen.getByTestId("job-timing").textContent).toMatch(/at most/i);
  });

  test("a running job reads as elapsed-so-far, and says it is still going", () => {
    render(
      <JobTimingCard
        timing={{
          startedMs: Date.parse(QUEUED_AT),
          updatedMs: Date.parse("2026-08-18T05:52:31.000Z"),
          elapsedMs: 95_000,
          isRunning: true,
        }}
      />,
    );

    expect(screen.getByText("Elapsed")).toBeInTheDocument();
    expect(screen.getByTestId("job-timing-elapsed")).toHaveTextContent("1m 35s");
    expect(screen.getByText("Last update")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  /**
   * The label is bounded by what the record holds. `created_at` is when the submission was *accepted*; no
   * column records when the sandbox began compiling, so this must not claim to.
   */
  test("does not claim to be when the build started", () => {
    render(
      <JobTimingCard
        timing={{ startedMs: Date.parse(QUEUED_AT), elapsedMs: 1_000, isRunning: true }}
      />,
    );

    const text = screen.getByTestId("job-timing").textContent ?? "";
    expect(text).toMatch(/Queued at/);
    expect(text).not.toMatch(/build started/i);
    expect(text).toMatch(/waiting for a build slot is included/i);
  });
});
