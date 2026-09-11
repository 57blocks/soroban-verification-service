import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { legalBundleFixture } from "./legal-bundle.fixture";

const getLegalDocumentsMock = vi.fn(() => Promise.resolve(legalBundleFixture()));
const preflightVerification = vi.fn();
const submitVerification = vi.fn();

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

const FIRST_HASH = "6f63b808b23c1fd867b063108b9be72c3aa847f4f5e3f1fb95be6f3dddb09244";
const SECOND_HASH = "34fc22d0f0531ccd2bcc782b86a9af5523f2aca5a463a87af8df3899ffefba37";
const CONTRACT_ID = "C" + "A".repeat(55);

const preflightBody = (wasmHash: string, availableFields: Record<string, unknown>) => ({
  data: {
    target: { network: "mainnet", wasm_hash: wasmHash },
    wasm_hash: wasmHash,
    wasm_byte_size: 1024,
    metadata: { available: {}, missing: [] },
    available_fields: availableFields,
    missing_fields: ["source_sha256"],
    suggested_manifest: null,
    build_environment: { kind: "compose", intent: {}, trustLevel: "upstream_pinned" },
  },
});

const firstAnswer = () =>
  preflightBody(FIRST_HASH, {
    source_uri: "https://example.org/first.tar.gz",
    source_sha256: "a".repeat(64),
    bldarg: "contract build",
    bldopt: "--locked --features=first",
  });

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

/** Runs preflight once against the first target, leaving its recipe prefilled. */
const consoleOnFirstTarget = async () => {
  const { result } = renderHook(() => useVerificationConsole({ mode: "submit" }), { wrapper });
  act(() => {
    result.current.selectTargetType("wasm_hash");
    result.current.form.setValue("network", "mainnet");
    result.current.form.setValue("wasmHash", FIRST_HASH);
  });
  preflightVerification.mockResolvedValue(firstAnswer());
  await act(async () => {
    await result.current.submitTarget();
  });
  await waitFor(() => expect(result.current.isPreflightReady).toBe(true));
  expect(result.current.values.source_sha256).toBe("a".repeat(64));
  return result;
};

beforeEach(() => {
  preflightVerification.mockReset();
  submitVerification.mockReset();
});

describe("changing the target after preflight has answered", () => {
  // The defect: the prefill is a merge, so a field the next target's chain does not state stayed on
  // screen — and would be submitted — as the previous contract's.
  test("a second target that states nothing inherits none of the first one's recipe", async () => {
    const result = await consoleOnFirstTarget();

    act(() => {
      result.current.form.setValue("network", "testnet");
      result.current.form.setValue("wasmHash", SECOND_HASH);
    });
    preflightVerification.mockResolvedValue(preflightBody(SECOND_HASH, {}));
    await act(async () => {
      await result.current.submitTarget();
    });
    await waitFor(() => expect(result.current.isPreflightReady).toBe(true));

    expect(result.current.values.source_sha256).toBe("");
    expect(result.current.values.source_uri).toBe("");
    expect(result.current.values.bldarg).toBe("");
    expect(result.current.values.bldopt).toBe("");
  });

  test("a second target that states some of it gets those fields and no others", async () => {
    const result = await consoleOnFirstTarget();

    act(() => {
      result.current.form.setValue("wasmHash", SECOND_HASH);
    });
    preflightVerification.mockResolvedValue(
      preflightBody(SECOND_HASH, { bldarg: "contract build --package second" }),
    );
    await act(async () => {
      await result.current.submitTarget();
    });
    await waitFor(() => expect(result.current.isPreflightReady).toBe(true));

    expect(result.current.values.bldarg).toBe("contract build --package second");
    expect(result.current.values.source_sha256).toBe("");
    expect(result.current.values.bldopt).toBe("");
  });

  // Editing the target is enough — the evidence must not survive to the moment preflight is re-run.
  test("the recipe is gone as soon as the target field is edited", async () => {
    const result = await consoleOnFirstTarget();

    act(() => {
      result.current.form.setValue("wasmHash", SECOND_HASH);
    });

    expect(result.current.preflight.phase).toBe("idle");
    expect(result.current.values.source_sha256).toBe("");
    expect(result.current.values.source_uri).toBe("");
  });

  test("switching the target picker clears it too", async () => {
    const result = await consoleOnFirstTarget();

    act(() => {
      result.current.selectTargetType("contract_id");
      result.current.form.setValue("contractId", CONTRACT_ID);
    });

    expect(result.current.preflight.phase).toBe("idle");
    expect(result.current.values.bldopt).toBe("");
  });

  // The picker mode was chosen for the target being left; leaving it on `upload_archive` asked for an
  // archive the new target had no reason to need.
  test("the source-access picker returns to its default", async () => {
    const result = await consoleOnFirstTarget();
    act(() => {
      result.current.sourceArchive.selectMode("upload_archive");
    });
    expect(result.current.sourceArchive.mode).toBe("upload_archive");

    act(() => {
      result.current.form.setValue("wasmHash", SECOND_HASH);
    });

    expect(result.current.sourceArchive.mode).toBe("public_uri");
    expect(result.current.sourceArchive.archive).toBeNull();
  });

  // The `incomplete` round trip is the same target, mid-flow: there the prefill must still merge, or it
  // would erase what the submitter has just typed.
  test("the incomplete round trip keeps what the submitter typed", async () => {
    const result = await consoleOnFirstTarget();
    // The chain's own hash, so the console's pre-submit chain-source check has nothing to refuse.
    act(() => {
      result.current.form.setValue("source_uri", "https://example.org/typed-by-hand.tar.gz");
    });
    submitVerification.mockResolvedValue({
      status: 200,
      data: {
        status: "incomplete",
        job_id: "job-1",
        missing_fields: ["bldopt"],
        available_fields: { bldopt: "--locked" },
      },
    });

    await act(async () => {
      await result.current.submitCompletedManifest();
    });

    expect(submitVerification).toHaveBeenCalledTimes(1);
    expect(result.current.values.bldopt).toBe("--locked");
    expect(result.current.values.source_uri).toBe("https://example.org/typed-by-hand.tar.gz");
    expect(result.current.values.source_sha256).toBe("a".repeat(64));
  });
});
