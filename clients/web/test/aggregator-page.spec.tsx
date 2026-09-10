import type { ReactElement } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AggregatorPage } from "@/features/aggregator/components/AggregatorPage";

const WASM_HASH = "a".repeat(64);
const ROOT = "https://peer.example/public";

const renderPage = (ui: ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TVL = {
  schema: "stellar-trusted-verifiers-list-v1",
  updated_at: "2026-08-19T00:00:00.000Z",
  verifiers: [
    {
      id: "peer-1",
      display_name: "peer-1",
      url: "https://a.example/public",
      manifest_url: "https://a.example/public/verifier-manifest.json",
      status: "active",
    },
    {
      id: "peer-2",
      display_name: "peer-2",
      url: "https://b.example/public",
      manifest_url: "https://b.example/public/verifier-manifest.json",
      status: "active",
    },
  ],
};

const AGGREGATE = {
  schema_version: "1.0",
  wasm_hash: WASM_HASH,
  updated_at: "2026-08-19T00:00:00.000Z",
  source_code_verifications: [
    { verifier: { name: "peer-1" }, status: "verified", processed_at: "2026-08-19T00:00:00.000Z" },
  ],
  unavailable_verifiers: [],
  agreement: "single",
};

const ROOT_DOC = {
  schema_version: "1.0",
  wasm_hash: WASM_HASH,
  updated_at: "2026-08-19T00:00:00.000Z",
  source_code_verifications: [
    {
      verifier: { name: "An Outside Verifier" },
      status: "mismatched",
      processed_at: "2026-08-19T00:00:00.000Z",
      rebuilt_hash: "b".repeat(64),
    },
  ],
};

const stub = (handler: (url: string) => Response) => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      return handler(url);
    }),
  );
  return calls;
};

const route = (url: string) => {
  if (url.includes("/api/query/v1/verifiers")) return json(TVL);
  if (url.includes("/api/query/v1/wasms/")) return json(AGGREGATE);
  if (url.startsWith(ROOT)) return json(ROOT_DOC);
  return new Response("", { status: 404 });
};

afterEach(() => vi.unstubAllGlobals());

describe("the aggregator page", () => {
  test("names itself, and offers both lookups", async () => {
    stub(route);
    renderPage(<AggregatorPage />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Aggregated Verification Results");
    expect(screen.getByTestId("query-tab-hash")).toBeInTheDocument();
    expect(screen.getByTestId("query-tab-contract")).toBeInTheDocument();
  });

  // Collapsed, the badge is the only thing a section still says — so it has to say the number that changes what
  // the answers below are made of.
  test("both sections start collapsed and carry their count", async () => {
    stub(route);
    renderPage(<AggregatorPage />);

    // "…" until the list arrives — a collapsed section showing 0 would claim it aggregates across nobody.
    expect(screen.getByTestId("tvl-section-badge").textContent).toBe("…");
    await waitFor(() => expect(screen.getByTestId("tvl-section-badge").textContent).toBe("2"));
    expect(screen.getByTestId("roots-section-badge").textContent).toBe("0");
    expect(screen.queryByTestId("tvl-list")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("tvl-section-toggle"));
    expect(await screen.findByTestId("tvl-list")).toBeInTheDocument();
  });

  test("an added root shows in the badge and is gone when removed", async () => {
    stub(route);
    renderPage(<AggregatorPage />);
    await userEvent.click(screen.getByTestId("roots-section-toggle"));

    await userEvent.type(screen.getByLabelText("Additional result root"), ROOT);
    await userEvent.click(screen.getByRole("button", { name: /add root/i }));

    expect(screen.getByTestId("roots-section-badge").textContent).toBe("1");

    await userEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(screen.getByTestId("roots-section-badge").textContent).toBe("0");
  });

  test.each([
    ["not-a-url", "not a URL"],
    ["javascript:alert(1)", "http(s)"],
  ])("%p is refused rather than added", async (value, expected) => {
    stub(route);
    renderPage(<AggregatorPage />);
    await userEvent.click(screen.getByTestId("roots-section-toggle"));

    await userEvent.type(screen.getByLabelText("Additional result root"), value);
    await userEvent.click(screen.getByRole("button", { name: /add root/i }));

    expect((await screen.findByTestId("additional-root-error")).textContent).toContain(expected);
    expect(screen.getByTestId("roots-section-badge").textContent).toBe("0");
  });

  test("the same root cannot be added twice", async () => {
    stub(route);
    renderPage(<AggregatorPage />);
    await userEvent.click(screen.getByTestId("roots-section-toggle"));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await userEvent.type(screen.getByLabelText("Additional result root"), ROOT);
      await userEvent.click(screen.getByRole("button", { name: /add root/i }));
    }

    expect((await screen.findByTestId("additional-root-error")).textContent).toContain("already in the list");
    expect(screen.getByTestId("roots-section-badge").textContent).toBe("1");
  });

  // The two sources answer different questions and must not be summarised together: an aggregate is a claim
  // about a curated set, an ad-hoc list is not.
  test("a hash lookup reports the aggregate and the added roots in separate sections", async () => {
    const calls = stub(route);
    renderPage(<AggregatorPage />);

    await userEvent.click(screen.getByTestId("roots-section-toggle"));
    await userEvent.type(screen.getByLabelText("Additional result root"), ROOT);
    await userEvent.click(screen.getByRole("button", { name: /add root/i }));

    const hashPanel = within(screen.getByTestId("tab-panel-hash"));
    await userEvent.type(hashPanel.getByLabelText("Wasm hash"), WASM_HASH);
    await userEvent.click(hashPanel.getByRole("button", { name: /look up/i }));

    const aggregate = await screen.findByTestId("explorer-results");
    expect(aggregate.textContent).toContain("peer-1");

    const roots = await screen.findByTestId("additional-root-results");
    expect(within(roots).getByText(/An Outside Verifier/)).toBeInTheDocument();
    // The outside verifier's answer is NOT folded into the aggregate.
    expect(aggregate.textContent).not.toContain("An Outside Verifier");

    expect(calls.some((url) => url === `${ROOT}/wasms/${WASM_HASH}.json`)).toBe(true);
    expect(calls.some((url) => url.includes(`/api/query/v1/wasms/${WASM_HASH}`))).toBe(true);
  });

  // Owner call: address resolution is query-svc's, so the contract tab has no roots section.
  test("the contract tab has no additional-roots section", async () => {
    stub(route);
    renderPage(<AggregatorPage />);
    await userEvent.click(screen.getByTestId("roots-section-toggle"));
    await userEvent.type(screen.getByLabelText("Additional result root"), ROOT);
    await userEvent.click(screen.getByRole("button", { name: /add root/i }));

    await userEvent.click(screen.getByTestId("query-tab-contract"));

    const contractPanel = screen.getByTestId("tab-panel-contract");
    expect(contractPanel).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("tab-panel-hash")).toHaveAttribute("hidden");
    expect(within(contractPanel).queryByTestId("additional-root-results")).not.toBeInTheDocument();
  });

  // A heading with nothing under it is not a section. Nothing below the form until something is asked, and the
  // source headings only once there are two sources to tell apart.
  test("no section headings before a lookup", async () => {
    stub(route);
    renderPage(<AggregatorPage />);

    await userEvent.click(screen.getByTestId("roots-section-toggle"));
    await userEvent.type(screen.getByLabelText("Additional result root"), ROOT);
    await userEvent.click(screen.getByRole("button", { name: /add root/i }));

    const panel = within(screen.getByTestId("tab-panel-hash"));
    expect(panel.queryByText("Trusted verifiers")).not.toBeInTheDocument();
    expect(panel.queryByText("Additional result roots")).not.toBeInTheDocument();
  });

  test("one source needs no heading naming it", async () => {
    stub(route);
    renderPage(<AggregatorPage />);

    const panel = within(screen.getByTestId("tab-panel-hash"));
    await userEvent.type(panel.getByLabelText("Wasm hash"), WASM_HASH);
    await userEvent.click(panel.getByRole("button", { name: /look up/i }));

    await screen.findByTestId("explorer-results");
    expect(panel.queryByText("Trusted verifiers")).not.toBeInTheDocument();
  });

  test("adding a root is what makes the two sources worth naming", async () => {
    stub(route);
    renderPage(<AggregatorPage />);

    await userEvent.click(screen.getByTestId("roots-section-toggle"));
    await userEvent.type(screen.getByLabelText("Additional result root"), ROOT);
    await userEvent.click(screen.getByRole("button", { name: /add root/i }));

    const panel = within(screen.getByTestId("tab-panel-hash"));
    await userEvent.type(panel.getByLabelText("Wasm hash"), WASM_HASH);
    await userEvent.click(panel.getByRole("button", { name: /look up/i }));

    await screen.findByTestId("explorer-results");
    expect(panel.getByText("Trusted verifiers")).toBeInTheDocument();
    expect(panel.getByText("Additional result roots")).toBeInTheDocument();
  });

  // A failed read is not a count. Collapsed, the badge is all the section says, and `0` would assert this
  // deployment aggregates across nobody when the truth is the list could not be read.
  test("the badge stays unknown when the TVL cannot be read", async () => {
    stub((url) => (url.includes("/verifiers") ? new Response("", { status: 503 }) : json({})));
    renderPage(<AggregatorPage />);

    await waitFor(() => expect(screen.getByTestId("tvl-section-badge").textContent).toBe("…"));
  });

  test("a 200 without verifiers does not crash the page", async () => {
    stub((url) =>
      url.includes("/verifiers") ? json({ schema: "stellar-trusted-verifiers-list-v1" }) : json({}),
    );
    renderPage(<AggregatorPage />);

    await waitFor(() => expect(screen.getByTestId("tvl-section-badge").textContent).toBe("…"));
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  // One press must re-ask both sources, or the two sections drift apart with nothing saying so.
  test("Look up on an unchanged hash re-asks the added roots too", async () => {
    const calls = stub(route);
    renderPage(<AggregatorPage />);

    await userEvent.click(screen.getByTestId("roots-section-toggle"));
    await userEvent.type(screen.getByLabelText("Additional result root"), ROOT);
    await userEvent.click(screen.getByRole("button", { name: /add root/i }));

    const panel = within(screen.getByTestId("tab-panel-hash"));
    await userEvent.type(panel.getByLabelText("Wasm hash"), WASM_HASH);
    await userEvent.click(panel.getByRole("button", { name: /look up/i }));
    await screen.findByTestId("additional-root-results");

    const before = calls.filter((url) => url.startsWith(ROOT)).length;
    await userEvent.click(panel.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(calls.filter((url) => url.startsWith(ROOT)).length).toBeGreaterThan(before));
  });

  // Variants that resolve to one document must not become two rows claiming two publishers agree.
  test("a root that resolves identically is refused as a duplicate", async () => {
    stub(route);
    renderPage(<AggregatorPage />);
    await userEvent.click(screen.getByTestId("roots-section-toggle"));

    for (const value of [ROOT, `${ROOT}?v=2`]) {
      await userEvent.clear(screen.getByLabelText("Additional result root"));
      await userEvent.type(screen.getByLabelText("Additional result root"), value);
      await userEvent.click(screen.getByRole("button", { name: /add root/i }));
    }

    expect((await screen.findByTestId("additional-root-error")).textContent).toContain("already in the list");
    expect(screen.getByTestId("roots-section-badge").textContent).toBe("1");
  });
});
