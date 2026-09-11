import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, AxiosHeaders } from "axios";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { legalBundleFixture } from "./legal-bundle.fixture";

const preflightVerification = vi.fn();
const submitVerification = vi.fn();

vi.mock("@scvs/verify-api-client", () => ({
  getLegalDocuments: () => Promise.resolve(legalBundleFixture()),
  usePreflightVerification: () => ({ mutateAsync: preflightVerification }),
  useSubmitVerification: () => ({ mutateAsync: submitVerification }),
  useUploadSource: () => ({ mutateAsync: vi.fn() }),
  AXIOS_INSTANCE: { defaults: {} },
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
vi.mock("sonner", () => ({ toast }));

// The real `errorMessage`/`isHttpError` are what this suite is about, so only the two environment-reading
// helpers are replaced.
vi.mock("@/lib/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http")>()),
  isApiBaseConfigured: () => true,
  getApiBase: () => "",
}));

const { useVerificationConsole } = await import("@/features/verification/hooks/use-verification-console");

const CONTRACT_ID = "C" + "A".repeat(55);

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

/** The `SubmitErrorResponse` envelope as `errorBody()` actually puts it on the wire: 400, no `status`. */
const submitErrorRejection = (body: Record<string, unknown>, status = 400) => {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError("Request failed with status code 400", "ERR_BAD_REQUEST", config, {}, {
    status,
    statusText: "Bad Request",
    data: body,
    headers: {},
    config,
  });
};

const runToSubmit = async (availableFields: Record<string, string> = {}) => {
  preflightVerification.mockResolvedValue({
    data: {
      target: { network: "testnet", contract_id: CONTRACT_ID },
      wasm_hash: "a".repeat(64),
      wasm_byte_size: 1024,
      metadata: { available: {}, missing: [] },
      available_fields: availableFields,
      missing_fields: ["source_sha256"],
      suggested_manifest: null,
      build_environment: { kind: "compose", intent: {}, trustLevel: "upstream_pinned" },
    },
  });

  const { result } = renderHook(() => useVerificationConsole({ mode: "submit" }), { wrapper });
  act(() => {
    result.current.form.setValue("contractId", CONTRACT_ID);
  });
  await act(async () => {
    await result.current.submitTarget();
  });
  act(() => {
    result.current.form.setValue("source_sha256", "b".repeat(64));
    result.current.form.setValue("source_uri", "https://example.org/src.tar.gz");
  });
  await act(async () => {
    await result.current.submitCompletedManifest();
  });
  return result;
};

beforeEach(() => {
  preflightVerification.mockReset();
  submitVerification.mockReset();
  toast.error.mockReset();
  toast.success.mockReset();
  toast.warning.mockReset();
});

describe("a synchronous submit rejection keeps the server's explanation", () => {
  test("source_hash_mismatch reaches the submitter as the verifier stated it", async () => {
    submitVerification.mockRejectedValue(
      submitErrorRejection({
        schema_version: "1.0",
        error: "source_hash_mismatch",
        detail: "manifest.source_sha256 does not match the hash computed when the archive was uploaded.",
        message: "manifest.source_sha256 does not match the hash computed when the archive was uploaded.",
        status_code: 400,
      }),
    );

    const result = await runToSubmit();

    expect(result.current.submissionState).toBe("error");
    expect(result.current.banner.code).toBe("source_hash_mismatch");
    expect(result.current.banner.detail).toBe(
      "manifest.source_sha256 does not match the hash computed when the archive was uploaded.",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "manifest.source_sha256 does not match the hash computed when the archive was uploaded.",
    );
  });

  // Same envelope, an arm with no `detail` of its own — the code must still reach the submitter rather than
  // being flattened into the generic copy.
  test("upload_expired keeps its own sentence too", async () => {
    submitVerification.mockRejectedValue(
      submitErrorRejection({
        schema_version: "1.0",
        error: "upload_expired",
        message: "upload_id abc has expired. Upload the source archive again.",
        status_code: 400,
      }),
    );

    const result = await runToSubmit();

    expect(result.current.banner.code).toBe("upload_expired");
    expect(toast.error).toHaveBeenCalledWith("upload_id abc has expired. Upload the source archive again.");
  });

  // The browser refuses this at the picker when preflight read a hash (`chain-source-gate.spec.tsx`), but that
  // gate is off whenever the chain could not be read, and a contract can be redeployed between preflight and
  // submit.
  test("source_archive_not_chain_recorded arrives with the server's own explanation", async () => {
    const detail =
      "The source archive you submitted hashes to " + "b".repeat(64) + ", but this contract records " +
      "source_sha256=" + "a".repeat(64) + " on chain. They must be the same archive, byte for byte.";
    submitVerification.mockRejectedValue(
      submitErrorRejection({
        schema_version: "1.0",
        error: "source_archive_not_chain_recorded",
        detail,
        message: detail,
        status_code: 400,
      }),
    );

    const result = await runToSubmit();

    expect(result.current.submissionState).toBe("error");
    expect(result.current.banner.code).toBe("source_archive_not_chain_recorded");
    expect(result.current.banner.detail).toBe(detail);
    expect(toast.error).toHaveBeenCalledWith(detail);
  });

  // The complaint this closes: the console showed the refusal *after* asking for it.
  test("a form hash the chain does not record never reaches the endpoint", async () => {
    const result = await runToSubmit({ source_sha256: "a".repeat(64) });

    expect(submitVerification).not.toHaveBeenCalled();
    // The banner is set too, not just a toast: skipping the round trip must not cost the submitter the durable
    // half of the message the server's own refusal would have produced.
    expect(result.current.submissionState).toBe("error");
    expect(result.current.banner.code).toBe("source_archive_not_chain_recorded");
    expect(result.current.banner.detail).toContain("a".repeat(64));
    expect(result.current.banner.detail).toContain("b".repeat(64));
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  test("a form hash that agrees with the chain is submitted normally", async () => {
    submitVerification.mockResolvedValue({
      status: 202,
      data: {
        status: "queued",
        job_id: "job-1",
        target: { network: "testnet", contract_id: CONTRACT_ID },
      },
    });

    // `runToSubmit` sets the form's source_sha256 to "b" * 64.
    await runToSubmit({ source_sha256: "b".repeat(64) });

    expect(submitVerification).toHaveBeenCalledTimes(1);
  });

  // The generated union requires `status` on both submit variants, so `normalizeStatus`'s guesswork — and the
  // `data.reason` read inside it — has no remaining input.
  test("an accepted submission is not routed through the failure path", async () => {
    submitVerification.mockResolvedValue({
      status: 202,
      data: {
        status: "queued",
        job_id: "job-9",
        target: { network: "testnet", contract_id: CONTRACT_ID },
        message: "Verification job created and queued for processing.",
      },
    });

    const result = await runToSubmit();

    expect(result.current.submissionState).toBe("queued");
    expect(result.current.banner.code).toBeUndefined();
    expect(toast.success).toHaveBeenCalledWith("Verification job queued");
    expect(toast.error).not.toHaveBeenCalled();
  });

  test("a transport failure is still reported as one", async () => {
    submitVerification.mockRejectedValue(new Error("Network Error"));

    const result = await runToSubmit();

    expect(result.current.submissionState).toBe("error");
    expect(result.current.banner.code).toBe("network_error");
    expect(result.current.banner.detail).toBe("Network Error");
  });
});
