import type { ReactElement } from "react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ContractLookup } from "@/features/aggregator/components/ContractLookup";
import { HashLookup } from "@/features/aggregator/components/HashLookup";
import { TrustedVerifiers } from "@/features/aggregator/components/TrustedVerifiers";
import { useRootLookups } from "@/features/aggregator/hooks/use-root-lookups";
import { isContractId } from "@/features/aggregator/hooks/use-contract-lookup";

const CONTRACT_ID = `C${"A".repeat(55)}`;
const WASM_HASH = "a".repeat(64);

/** A fresh client per test: a shared cache would let one case answer another's query. */
const renderWithQuery = (ui: ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

const refusal = (status: number, error: string, message: string) =>
  new Response(JSON.stringify({ error, message, status_code: status }), {
    status,
    headers: { "content-type": "application/json" },
  });

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const ENTRY = {
  verifier: { name: "Peer One" },
  status: "verified",
  processed_at: "2026-08-17T00:00:00.000Z",
};

const aggregatedStatus = (over: Record<string, unknown> = {}) => ({
  schema_version: "1.0",
  wasm_hash: WASM_HASH,
  updated_at: "2026-08-17T00:00:00.000Z",
  source_code_verifications: [ENTRY],
  unavailable_verifiers: [],
  agreement: "single",
  ...over,
});

const notRetained = (over: Record<string, unknown> = {}) =>
  aggregatedStatus({ source_code_verifications: [], agreement: "no_data", ...over });

const stubFetch = (handler: (url: string) => Response) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => handler(String(input))),
  );

afterEach(() => vi.unstubAllGlobals());

describe("looking up one hash in this deployment's aggregate", () => {
  const lookUp = async (value: string) => {
    await userEvent.type(screen.getByLabelText("Wasm hash"), value);
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));
  };

  test("asks the hash route, with no network in the path", async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      return ok(aggregatedStatus({ agreement: "unanimous_verified", source_code_verifications: [ENTRY, ENTRY] }));
    });

    renderWithQuery(<HashLookup />);
    await lookUp(WASM_HASH);

    const results = await screen.findByTestId("explorer-results");
    expect(results.textContent).toContain("reports these bytes verified");
    expect(calls[0]).toContain(`/api/query/v1/wasms/${WASM_HASH}`);
    expect(calls[0]).not.toMatch(/mainnet|testnet/);
  });

  test("a hash is normalised to lower case before it is asked about", async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      return ok(aggregatedStatus());
    });

    renderWithQuery(<HashLookup />);
    await lookUp(WASM_HASH.toUpperCase());

    await screen.findByTestId("explorer-results");
    expect(calls[0]).toContain(WASM_HASH);
  });

  test("a malformed hash is refused before any request is made", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    renderWithQuery(<HashLookup />);
    await lookUp("not-a-hash");

    expect(await screen.findByTestId("hash-invalid")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("pressing Look up again on an unchanged hash re-asks", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return refusal(503, "aggregation_unavailable", "the aggregation index is still building");
      }),
    );

    renderWithQuery(<HashLookup />);
    await lookUp(WASM_HASH);
    await screen.findByTestId("hash-failed");
    expect(calls).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(calls).toHaveLength(2));
  });

  test("an empty aggregate is reported as what this deployment holds, not as a verdict", async () => {
    stubFetch(() => ok(notRetained()));

    renderWithQuery(<HashLookup />);
    await lookUp(WASM_HASH);

    const empty = await screen.findByTestId("hash-empty");
    expect(empty.textContent).toContain("No result in this deployment's aggregate");
    expect(empty.textContent).toContain("not what any verifier has published");
    expect(screen.queryByTestId("explorer-results")).not.toBeInTheDocument();
  });

  test("Refresh re-asks, and an answer that has since landed replaces the empty state", async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return ok(calls === 1 ? notRetained() : aggregatedStatus());
    });

    renderWithQuery(<HashLookup />);
    await lookUp(WASM_HASH);
    await screen.findByTestId("hash-empty");

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await screen.findByTestId("explorer-results");
    expect(screen.queryByTestId("hash-empty")).not.toBeInTheDocument();
  });

  test("the assembled timestamp is not described as when the aggregate changed", async () => {
    stubFetch(() => ok(aggregatedStatus()));

    renderWithQuery(<HashLookup />);
    await lookUp(WASM_HASH);

    const results = await screen.findByTestId("explorer-results");
    expect(results.textContent).toContain("assembled from the retained aggregate, not when it changed");
  });

  test("an unreachable verifier stays visible even when nothing has been retained", async () => {
    stubFetch(() =>
      ok(
        notRetained({
          unavailable_verifiers: [
            { url: "https://peer-one.example/", name: "Peer One", reason: "fetch_failed", error: "timeout" },
          ],
        }),
      ),
    );

    renderWithQuery(<HashLookup />);
    await lookUp(WASM_HASH);

    await screen.findByTestId("hash-empty");
    const unavailable = await screen.findByTestId("explorer-unavailable");
    expect(unavailable.textContent).toContain("Peer One");
    expect(unavailable.textContent).toContain("fetch_failed");
    expect(unavailable.textContent).toContain("not evidence either way");
  });
});

describe("the aggregate is read through the SDK", () => {
  const lookUpHash = async () => {
    renderWithQuery(<HashLookup />);
    await userEvent.type(screen.getByLabelText("Wasm hash"), WASM_HASH);
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));
  };

  test("a higher MINOR of the schema we read is tolerated (SO7/CV6)", async () => {
    stubFetch(() => ok(aggregatedStatus({ schema_version: "1.7" })));

    await lookUpHash();

    expect((await screen.findByTestId("explorer-results")).textContent).toContain("One verifier has a result");
  });

  test("a MAJOR we do not read is refused rather than rendered", async () => {
    stubFetch(() => ok(aggregatedStatus({ schema_version: "2.0" })));

    await lookUpHash();

    const failed = await screen.findByTestId("hash-failed");
    expect(failed.textContent).toContain("schema_version");
    expect(screen.queryByTestId("explorer-results")).not.toBeInTheDocument();
  });
});

describe("a 200 that is not JSON is named, not surfaced as a parse error", () => {
  test("an unrouted API path reports a query-API failure, not a SyntaxError", async () => {
    stubFetch(
      () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );

    renderWithQuery(<HashLookup />);
    await userEvent.type(screen.getByLabelText("Wasm hash"), WASM_HASH);
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));

    const failed = await screen.findByTestId("hash-failed");
    expect(failed.textContent).toContain("not JSON");
    expect(failed.textContent).toContain("routed to query-svc");
    expect(failed.textContent).not.toContain("Unexpected token");
  });
});

describe("the contract look-up keeps every refusal distinguishable", () => {
  const lookup = async (response: Response) => {
    stubFetch(() => response);
    renderWithQuery(<ContractLookup />);
    await userEvent.type(screen.getByLabelText("Contract address"), CONTRACT_ID);
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));
    return screen.findByTestId("contract-failed");
  };

  test("contract_not_found says the address holds nothing verifiable", async () => {
    const failed = await lookup(
      refusal(404, "contract_not_found", "No Wasm-executable contract at that address"),
    );
    expect(failed.textContent).toContain("No Wasm-executable contract is deployed");
  });

  test("address_resolution_failed is not reported as a verdict", async () => {
    const failed = await lookup(refusal(502, "address_resolution_failed", "rpc timeout"));

    expect(failed.textContent).toContain("ledger could not be reached");
    expect(failed.textContent).toContain("says nothing about whether the contract is verified");
    expect(failed.textContent).not.toContain("not verified.");
  });

  test("invalid_network is told apart from a malformed address", async () => {
    const failed = await lookup(refusal(400, "invalid_network", "network must be mainnet or testnet"));
    expect(failed.textContent).toContain("not one the query API serves");
  });

  test("a transport failure is named as one rather than as a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("connection refused"))));
    renderWithQuery(<ContractLookup />);
    await userEvent.type(screen.getByLabelText("Contract address"), CONTRACT_ID);
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));

    const failed = await screen.findByTestId("contract-failed");
    expect(failed.textContent).toContain("could not be reached");
  });

  test("a malformed address is refused before any request is made", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    renderWithQuery(<ContractLookup />);
    await userEvent.type(screen.getByLabelText("Contract address"), "CNOPE");
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));

    expect(await screen.findByTestId("contract-invalid")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("pressing Look up again on an unchanged address re-asks", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return refusal(502, "address_resolution_failed", "rpc timeout");
      }),
    );

    renderWithQuery(<ContractLookup />);
    await userEvent.type(screen.getByLabelText("Contract address"), CONTRACT_ID);
    await userEvent.click(screen.getByRole("button", { name: /look up/i }));
    await screen.findByTestId("contract-failed");
    expect(calls).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(calls).toHaveLength(2));
  });

  test("only a `C` plus 55 base32 characters is a contract address", () => {
    expect(isContractId(CONTRACT_ID)).toBe(true);
    expect(isContractId(` ${CONTRACT_ID.toLowerCase()} `)).toBe(true);
    expect(isContractId(`C${"A".repeat(54)}`)).toBe(false);
    expect(isContractId(`G${"A".repeat(55)}`)).toBe(false);
    expect(isContractId(`C${"1".repeat(55)}`)).toBe(false);
    expect(isContractId("")).toBe(false);
  });
});

describe("the trusted verifiers page treats peer fields as untrusted", () => {
  const tvl = (over: Record<string, unknown> = {}) =>
    ok({
      schema: "stellar-trusted-verifiers-list-v1",
      updated_at: "2026-08-17T00:00:00.000Z",
      verifiers: [
        {
          id: "peer-1",
          display_name: "Peer One",
          url: "https://peer.example/results/",
          manifest_url: "https://peer.example/results/verifier-manifest.json",
          status: "active",
          ...over,
        },
      ],
    });

  test("logo_url is never fetched", async () => {
    stubFetch(() => tvl({ logo_url: "https://peer.example/logo.png" }));

    renderWithQuery(<TrustedVerifiers />);

    const list = await screen.findByTestId("tvl-list");
    expect(list.querySelector("img")).toBeNull();
  });

  test("a hostile display name renders as text", async () => {
    stubFetch(() => tvl({ display_name: "<img src=x onerror=alert(1)>" }));

    renderWithQuery(<TrustedVerifiers />);

    const list = await screen.findByTestId("tvl-list");
    expect(list.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(list.querySelector("img")).toBeNull();
  });

  test("the id is not repeated when it is all the display name is", async () => {
    stubFetch(() => tvl({ id: "peer-1", display_name: "peer-1" }));

    renderWithQuery(<TrustedVerifiers />);

    const list = await screen.findByTestId("tvl-list");
    expect(list.textContent?.match(/peer-1/g)).toHaveLength(1);
  });

  test("an entry with neither id nor display_name is named by its result root", async () => {
    stubFetch(() =>
      ok({
        schema: "stellar-trusted-verifiers-list",
        schema_version: "1.0",
        updated_at: "2026-09-09T00:00:00.000Z",
        verifiers: [{ url: "https://nameless.example/results/", status: "active" }],
      }),
    );

    renderWithQuery(<TrustedVerifiers />);

    const list = await screen.findByTestId("tvl-list");
    expect(list.textContent).toContain("https://nameless.example/results/");
    expect(list.textContent).not.toContain("undefined");
  });

  test("two entries with no id render as two rows", async () => {
    stubFetch(() =>
      ok({
        schema: "stellar-trusted-verifiers-list",
        schema_version: "1.0",
        updated_at: "2026-09-09T00:00:00.000Z",
        verifiers: [
          { url: "https://one.example/", status: "active" },
          { url: "https://two.example/", status: "active" },
        ],
      }),
    );

    renderWithQuery(<TrustedVerifiers />);

    const list = await screen.findByTestId("tvl-list");
    expect(list.querySelectorAll("li")).toHaveLength(2);
  });

  test("two entries sharing a local id render as two rows", async () => {
    stubFetch(() =>
      ok({
        schema: "stellar-trusted-verifiers-list",
        schema_version: "1.0",
        updated_at: "2026-09-09T00:00:00.000Z",
        verifiers: [
          { id: "peer-1", display_name: "One", url: "https://one.example/", status: "active" },
          { id: "peer-1", display_name: "Two", url: "https://two.example/", status: "active" },
        ],
      }),
    );

    renderWithQuery(<TrustedVerifiers />);

    const list = await screen.findByTestId("tvl-list");
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(list.textContent).toContain("One");
    expect(list.textContent).toContain("Two");
  });

  test("a real display name is shown alongside the id", async () => {
    stubFetch(() => tvl({ id: "peer-1", display_name: "Peer One" }));

    renderWithQuery(<TrustedVerifiers />);

    const list = await screen.findByTestId("tvl-list");
    expect(list.textContent).toContain("Peer One");
    expect(list.textContent).toContain("peer-1");
  });

  test("a peer with no bulk-load route says what it can and cannot contribute", async () => {
    stubFetch(() => tvl());

    renderWithQuery(<TrustedVerifiers />);

    expect(await screen.findByTestId("tvl-not-enumerable")).toBeInTheDocument();
  });

  test("a bulk_load_url is shown, behind the same interstitial as any peer URL", async () => {
    stubFetch(() => tvl({ bulk_load_url: "https://peer.example/api/verification/v1/results/wasms.json" }));

    renderWithQuery(<TrustedVerifiers />);

    await screen.findByTestId("tvl-list");
    expect(screen.queryByTestId("tvl-not-enumerable")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("peer-link-pending")).toHaveLength(2);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("url goes through the interstitial rather than straight to an anchor", async () => {
    stubFetch(() => tvl());

    renderWithQuery(<TrustedVerifiers />);

    await screen.findByTestId("tvl-list");
    expect(screen.getByTestId("peer-link-pending").textContent).toContain("https://peer.example");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test.each([
    ["active", "bg-success-fg"],
    ["paused", "bg-warning-fg"],
    ["disabled", "bg-danger-fg"],
  ])("a %s verifier gets its own tone", async (status, tone) => {
    stubFetch(() => tvl({ status }));

    renderWithQuery(<TrustedVerifiers />);

    const list = await screen.findByTestId("tvl-list");
    expect(list.textContent).toContain(status);
    expect(list.querySelector(`.${tone}`)).not.toBeNull();
  });

  test("a 200 whose body has no verifiers is named, not rendered as empty", async () => {
    stubFetch(() => ok({ schema: "stellar-trusted-verifiers-list-v1", updated_at: "x" }));

    renderWithQuery(<TrustedVerifiers />);

    const failed = await screen.findByTestId("tvl-failed");
    expect(failed.textContent).toContain("not the expected shape");
    expect(screen.queryByTestId("tvl-list")).not.toBeInTheDocument();
  });
});

describe("asking an additional root directly", () => {
  const ROOT = { id: "https://peer.example/public", url: "https://peer.example/public" };

  const runHook = (hash: string, respond: (url: string) => Response) => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(url);
        return respond(url);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useRootLookups([ROOT], hash), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    return { calls, result };
  };

  const rootDocument = (over: Record<string, unknown> = {}) =>
    ok({
      schema_version: "1.0",
      wasm_hash: WASM_HASH,
      updated_at: "2026-08-19T00:00:00.000Z",
      source_code_verifications: [
        { verifier: { name: "Outside" }, status: "verified", processed_at: "2026-08-19T00:00:00.000Z" },
      ],
      ...over,
    });

  test.each(["not-a-hash", "a".repeat(63), "../../../etc/passwd"])(
    "%p is never sent to a root",
    async (bad) => {
      const { calls } = runHook(bad, () => ok({}));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toEqual([]);
    },
  );

  test("a valid hash is asked for under the root's own path", async () => {
    const { calls, result } = runHook(WASM_HASH, () => rootDocument());
    await waitFor(() => expect(result.current[0]!.phase).toBe("answered"));
    expect(calls).toEqual([`${ROOT.url}/wasms/${WASM_HASH}.json`]);
  });

  test("a document about different bytes is refused, not rendered", async () => {
    const { result } = runHook(WASM_HASH, () => rootDocument({ wasm_hash: "b".repeat(64) }));

    await waitFor(() => expect(result.current[0]!.phase).not.toBe("loading"));
    const outcome = result.current[0]!;
    expect(outcome.phase).toBe("failed");
    expect(outcome.phase === "failed" && outcome.error).toContain("not the hash that was asked about");
  });

  test("a 404 is an answer, not a failure", async () => {
    const { result } = runHook(WASM_HASH, () => new Response("", { status: 404 }));
    await waitFor(() => expect(result.current[0]!.phase).toBe("absent"));
  });
});
