import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { legalBundleFixture } from "./legal-bundle.fixture";
import { SourceAccessCard } from "@/features/verification/components/SourceAccessCard";
import { defaultValues } from "@/features/verification/constants";
import { sourceUriRefusal } from "@/features/verification/utils/evidence-rules.util";
import { buildInlineManifest } from "@/features/verification/utils/manifest.util";
import type {
  SourceAccessMode,
  VerifyFormValues,
} from "@/features/verification/types";

const preflightVerification = vi.fn();
const submitVerification = vi.fn();

vi.mock("@scvs/verify-api-client", async () => ({
  getLegalDocuments: () => Promise.resolve(legalBundleFixture()),
  usePreflightVerification: () => ({ mutateAsync: preflightVerification }),
  useSubmitVerification: () => ({ mutateAsync: submitVerification }),
  useUploadSource: () => ({ mutateAsync: vi.fn() }),
  jobEventsPath: (await vi.importActual<typeof import("@scvs/verify-api-client")>("@scvs/verify-api-client"))
    .jobEventsPath,
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

const CONTRACT_ID = "C" + "A".repeat(55);
const SHA = "b".repeat(64);

const readyPreflight = {
  data: {
    target: { network: "testnet", contract_id: CONTRACT_ID },
    wasm_hash: "a".repeat(64),
    wasm_byte_size: 1024,
    metadata: { available: {}, missing: [] },
    available_fields: {},
    missing_fields: ["source_sha256"],
    suggested_manifest: null,
    build_environment: { kind: "compose", intent: {}, trustLevel: "upstream_pinned" },
  },
};

/** `formState` is a Proxy tracking only slices a render has read, and this harness renders the hook alone. */
const fieldError = (
  form: { getFieldState: (name: never) => { error?: { message?: string } } },
  name: "source_sha256" | "source_uri",
) => form.getFieldState(name as never).error?.message;

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const openStageTwo = async () => {
  preflightVerification.mockResolvedValue(readyPreflight);
  const { result } = renderHook(() => useVerificationConsole({ mode: "submit" }), { wrapper });
  act(() => {
    result.current.form.setValue("contractId", CONTRACT_ID);
  });
  await act(async () => {
    await result.current.submitTarget();
  });
  expect(result.current.isPreflightReady).toBe(true);
  return result;
};

beforeEach(() => {
  preflightVerification.mockReset();
  submitVerification.mockReset();
  window.localStorage.clear();
});

describe("stage two validates the required evidence before it submits", () => {
  test("an empty source URI on the public-URI path issues no request", async () => {
    const result = await openStageTwo();

    act(() => {
      result.current.form.setValue("source_sha256", SHA);
      result.current.form.setValue("source_uri", "");
    });
    await act(async () => {
      await result.current.submitCompletedManifest();
    });

    expect(submitVerification).not.toHaveBeenCalled();
    expect(fieldError(result.current.form, "source_uri")).toMatch(/Enter the public URL/);
  });

  test("a source URI that is not a URI issues no request either", async () => {
    const result = await openStageTwo();

    act(() => {
      result.current.form.setValue("source_sha256", SHA);
      result.current.form.setValue("source_uri", "example.com/source.tar.gz");
    });
    await act(async () => {
      await result.current.submitCompletedManifest();
    });

    expect(submitVerification).not.toHaveBeenCalled();
    expect(fieldError(result.current.form, "source_uri")).toMatch(/full URI/);
  });

  test("a missing source_sha256 issues no request", async () => {
    const result = await openStageTwo();

    act(() => {
      result.current.form.setValue("source_uri", "https://example.org/src.tar.gz");
    });
    await act(async () => {
      await result.current.submitCompletedManifest();
    });

    expect(submitVerification).not.toHaveBeenCalled();
    expect(fieldError(result.current.form, "source_sha256")).toMatch(
      /Enter the source archive SHA-256/,
    );
  });

  test("both halves of 'required' are reported from a single press", async () => {
    const result = await openStageTwo();

    act(() => {
      result.current.sourceArchive.selectMode("upload_archive");
    });
    await act(async () => {
      await result.current.submitCompletedManifest();
    });

    expect(submitVerification).not.toHaveBeenCalled();
    expect(fieldError(result.current.form, "source_sha256")).toBeTruthy();
    expect(result.current.sourceArchive.error).toMatch(/Select the exact source archive/);
  });

  test("a complete public-URI submission still goes out", async () => {
    submitVerification.mockResolvedValue({
      status: 202,
      data: { status: "queued", job_id: "job-1" },
    });
    const result = await openStageTwo();

    act(() => {
      result.current.form.setValue("source_sha256", SHA);
      result.current.form.setValue("source_uri", "https://example.org/src.tar.gz");
      result.current.terms.onAcceptedChange(true);
    });
    await act(async () => {
      await result.current.submitCompletedManifest();
    });

    expect(submitVerification).toHaveBeenCalledTimes(1);
  });
});

describe("the source-URI rule accepts what the submit boundary accepts", () => {
  test.each([
    "https://example.com/source.tar.gz",
    "http://example.com/source.tar.gz",
    "ipfs://bafy.../source.tar.gz",
    "/srv/sources/source.tar.gz",
  ])("%s is accepted", (uri) => {
    expect(sourceUriRefusal(uri)).toBeNull();
  });

  test.each(["", "   ", "example.com/source.tar.gz", "9lives:x", "://nowhere"])(
    "%j is refused",
    (uri) => {
      expect(sourceUriRefusal(uri)).not.toBeNull();
    },
  );
});

const Card = ({ mode, archiveError }: { mode: SourceAccessMode; archiveError?: string }) => {
  const form = useForm<VerifyFormValues>({ defaultValues });
  return (
    <SourceAccessCard
      form={form}
      mode={mode}
      onModeChange={() => {}}
      archive={null}
      onSelectArchive={() => {}}
      archiveError={archiveError}
    />
  );
};

describe("the refusal is rendered beside the control that caused it", () => {
  test("the picker's refusal displaces the hint", () => {
    render(<Card mode="upload_archive" archiveError="Select the exact source archive to upload." />);

    expect(screen.getByTestId("source-access-message").textContent).toBe(
      "Select the exact source archive to upload.",
    );
  });

  test("with nothing to refuse, the hint is what shows", () => {
    render(<Card mode="upload_archive" />);

    expect(screen.getByTestId("source-access-message").textContent).toMatch(
      /Select the exact gzip tarball or zip/,
    );
  });
});

describe("the submitted source_sha256 is lowercase", () => {
  test("an uppercase paste is normalised on the way out", () => {
    const manifest = buildInlineManifest(
      { ...defaultValues, source_sha256: "AB".repeat(32), source_uri: "https://e.org/s.tar.gz" },
      undefined,
      "public_uri",
    );

    expect(manifest.source_sha256).toBe("ab".repeat(32));
  });
});
