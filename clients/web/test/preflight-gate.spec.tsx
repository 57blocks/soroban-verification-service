import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { legalBundleFixture } from "./legal-bundle.fixture";

const getLegalDocumentsMock = vi.fn(() => Promise.resolve(legalBundleFixture()));
const preflightVerification = vi.fn();
const submitVerification = vi.fn();

// The gate has to be observable as "no request was made", so the generated client's two mutation hooks are
// replaced with ones that record calls.
vi.mock("@scvs/verify-api-client", () => ({
  getLegalDocuments: () => getLegalDocumentsMock(),
  usePreflightVerification: () => ({ mutateAsync: preflightVerification }),
  useSubmitVerification: () => ({ mutateAsync: submitVerification }),
  useUploadSource: () => ({ mutateAsync: vi.fn() }),
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

const { useVerificationConsole } = await import("@/features/verification/hooks/use-verification-console");

const CONTRACT_ID = "C" + "A".repeat(55);

const preflightBody = (buildEnvironment: unknown) => ({
  data: {
    target: { network: "testnet", contract_id: CONTRACT_ID },
    wasm_hash: "a".repeat(64),
    wasm_byte_size: 1024,
    metadata: { available: {}, missing: [] },
    available_fields: {},
    missing_fields: ["source_sha256"],
    suggested_manifest: null,
    build_environment: buildEnvironment,
  },
});

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const runTarget = async () => {
  const { result } = renderHook(() => useVerificationConsole({ mode: "submit" }), { wrapper });
  act(() => {
    result.current.form.setValue("contractId", CONTRACT_ID);
  });
  await act(async () => {
    await result.current.submitTarget();
  });
  return result;
};

beforeEach(() => {
  preflightVerification.mockReset();
  submitVerification.mockReset();
});

describe("the preflight gate (UI1)", () => {
  test("an unsupported contract never reaches a submission", async () => {
    preflightVerification.mockResolvedValue(
      preflightBody({ kind: "unsupported", reason: "undated_nightly" }),
    );

    const result = await runTarget();

    await waitFor(() => expect(preflightVerification).toHaveBeenCalledTimes(1));
    expect(submitVerification).not.toHaveBeenCalled();
    expect(result.current.isPreflightReady).toBe(false);
    expect(result.current.showEvidenceForm).toBe(false);
  });

  test("a policy-rejected image never reaches a submission either", async () => {
    preflightVerification.mockResolvedValue(
      preflightBody({
        kind: "chain_named_policy_rejected",
        reason: "image_not_digest_pinned",
        detail: "not digest pinned",
      }),
    );

    await runTarget();

    expect(submitVerification).not.toHaveBeenCalled();
  });

  // The gate must hold even when the caller ignores it — this is the case a `disabled` attribute does not
  // cover.
  test("calling stage two directly on a blocked verdict still issues no request", async () => {
    preflightVerification.mockResolvedValue(
      preflightBody({ kind: "unsupported", reason: "unreleased_cli" }),
    );

    const result = await runTarget();
    act(() => {
      result.current.form.setValue("source_sha256", "b".repeat(64));
      result.current.form.setValue("source_uri", "https://example.org/src.tar.gz");
    });
    await act(async () => {
      await result.current.submitCompletedManifest();
    });

    expect(submitVerification).not.toHaveBeenCalled();
  });

  test("a preflight the console could not reach is not a verdict, and still blocks", async () => {
    preflightVerification.mockRejectedValue(new Error("network down"));

    const result = await runTarget();

    expect(result.current.preflight.phase).toBe("failed");
    expect(result.current.isPreflightReady).toBe(false);
    expect(submitVerification).not.toHaveBeenCalled();
  });

  test("a ready contract opens stage two and submits", async () => {
    preflightVerification.mockResolvedValue(
      preflightBody({ kind: "compose", intent: {}, trustLevel: "upstream_pinned" }),
    );
    submitVerification.mockResolvedValue({ status: 202, data: { status: "queued", job_id: "job-1" } });

    const result = await runTarget();
    expect(result.current.isPreflightReady).toBe(true);
    expect(result.current.showEvidenceForm).toBe(true);

    act(() => {
      result.current.form.setValue("source_sha256", "b".repeat(64));
      result.current.form.setValue("source_uri", "https://example.org/src.tar.gz");
    });
    await act(async () => {
      await result.current.submitCompletedManifest();
    });

    expect(submitVerification).toHaveBeenCalledTimes(1);
    // The version this browser was shown, taken from the fetched bundle rather than from any input
    // (versioned-terms-and-assent design.md TA-2).
    expect(submitVerification.mock.calls[0][0].data).toMatchObject({
      accepted_terms_version: legalBundleFixture().data.version,
    });
  });

  test("refuses to submit at all when the operator's bundle could not be loaded", async () => {
    // Nothing to accept means nothing to bind, so the console must not call the endpoint (TA-6).
    vi.mocked(getLegalDocumentsMock).mockRejectedValueOnce(new Error("no bundle"));
    preflightVerification.mockResolvedValue(
      preflightBody({ kind: "compose", intent: {}, trustLevel: "upstream_pinned" }),
    );

    const result = await runTarget();
    act(() => {
      result.current.form.setValue("source_sha256", "b".repeat(64));
      result.current.form.setValue("source_uri", "https://example.org/src.tar.gz");
    });
    await act(async () => {
      await result.current.submitCompletedManifest();
    });

    expect(result.current.canSubmit).toBe(false);
    expect(submitVerification).not.toHaveBeenCalled();
  });
});
