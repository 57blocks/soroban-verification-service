import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { legalBundleFixture } from "./legal-bundle.fixture";

/** `useBuildLog` calls the route through the shared axios instance — see the hook for why. */
const buildLogGet = vi.fn();

vi.mock("@scvs/verify-api-client", async () => ({
  getLegalDocuments: () => Promise.resolve(legalBundleFixture()),
  usePreflightVerification: () => ({ mutateAsync: vi.fn() }),
  useSubmitVerification: () => ({ mutateAsync: vi.fn() }),
  useUploadSource: () => ({ mutateAsync: vi.fn() }),
  // The route and its header are the generated client's, proved by `clients/api-client/src/client-test.ts`. What
  // this spec owns is *when* the console asks, and with which job and which token.
  getBuildLog: (...args: unknown[]) => buildLogGet(...args),
  // The real path, not a fake one: a spec that invented its own would pass against its own copy.
  jobEventsPath: (await vi.importActual<typeof import("@scvs/verify-api-client")>("@scvs/verify-api-client"))
    .jobEventsPath,
  AXIOS_INSTANCE: { defaults: {} },
}));

/** The hook asks for nothing without a token, so the fixture browser holds one. */
const TOKEN = "t".repeat(43);
vi.mock("@/features/verification/utils/build-log-tokens.store", () => ({
  rememberBuildLogToken: vi.fn(),
  readBuildLogToken: (jobId: string | null) => (jobId ? TOKEN : undefined),
  forgetBuildLogToken: vi.fn(),
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

/** A stream the test drives, replacing `setup.ts`'s inert stand-in. */
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
  created_at: "2026-08-18T05:52:30.148Z",
  updated_at: "2026-08-18T05:52:31.000Z",
  target: { network: "testnet", wasm_hash: "8e".repeat(32) },
  progress: { step: "chain_lookup", detail: "Fetching deployed Wasm and metadata." },
};

beforeEach(() => {
  buildLogGet.mockReset();
  buildLogGet.mockResolvedValue({ data: "cargo build --release\nFinished" });
  DrivableEventSource.last = null;
  globalThis.EventSource = DrivableEventSource as unknown as typeof EventSource;
});

/**
 * `GET /api/verification/v1/verifications/:id/log` answering 404 for a job that has not built is *correct* — the body carries
 * `job_status` and the reason.
 */
describe("the build log is not requested before the job has an outcome", () => {
  test("a queued job makes no request at all", async () => {
    const { result, stream } = openJob();
    await emit(stream, queuedEvent);

    await waitFor(() => expect(result.current.submissionState).toBe("queued"));
    expect(buildLogGet).not.toHaveBeenCalled();
    expect(result.current.buildLog.phase).toBe("idle");
  });

  test("the request is made once the job reaches an outcome, and gets the log", async () => {
    const { result, stream } = openJob();
    await emit(stream, queuedEvent);
    expect(buildLogGet).not.toHaveBeenCalled();

    await emit(stream, {
      ...queuedEvent,
      status: "verified",
      updated_at: "2026-08-18T05:56:42.000Z",
      result: { status_summary: "verified" },
    });

    await waitFor(() =>
      expect(buildLogGet).toHaveBeenCalledWith(JOB_ID, { "x-build-log-token": TOKEN }),
    );
    await waitFor(() =>
      expect(result.current.buildLog).toEqual({
        phase: "log",
        text: "cargo build --release\nFinished",
      }),
    );
    // Exactly one: a second request would mean the queued state had also fired one.
    expect(buildLogGet).toHaveBeenCalledTimes(1);
  });

  // `not_attempted` and `policy_rejected` are reached before any build, so their 404 is the honest answer and
  // the pane renders the reason.
  test("an outcome that never built still asks, so the pane can show why", async () => {
    const { stream } = openJob();
    await emit(stream, queuedEvent);
    await emit(stream, {
      ...queuedEvent,
      status: "not_attempted",
      updated_at: "2026-08-18T05:53:00.000Z",
    });

    await waitFor(() => expect(buildLogGet).toHaveBeenCalledTimes(1));
  });
});
