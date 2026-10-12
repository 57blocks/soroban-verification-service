import { Address, StrKey, xdr } from "@stellar/stellar-base";
import { MalformedContractIdError } from "../src/modules/results/address-resolver.js";
import { StellarRpcAddressResolver } from "../src/modules/results/stellar-rpc.resolver.js";
import { ResultsController } from "../src/modules/results/results.controller.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const WASM_HASH = "ab".repeat(32);
const RPC_URL = "https://rpc.example/testnet";

function ledgerEntry(executable: xdr.ContractExecutable): string {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(CONTRACT_ID).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    }),
  ).toXDR("base64");
}

function resolverAnswering(body: unknown, init: ResponseInit = {}): StellarRpcAddressResolver {
  const config = {
    get(key: string) {
      if (key === "stellarRpcUrlTestnet") return RPC_URL;
      if (key === "stellarRpcUrlMainnet") return "";
      return 5_000;
    },
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, ...init })) as typeof fetch;
  return new StellarRpcAddressResolver(config as never);
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("StellarRpcAddressResolver", () => {
  it("decodes the Wasm hash a contract instance points at", async () => {
    const resolver = resolverAnswering({
      result: { entries: [{ xdr: ledgerEntry(xdr.ContractExecutable.contractExecutableWasm(Buffer.from(WASM_HASH, "hex"))) }] },
    });
    expect(await resolver.resolve("testnet", CONTRACT_ID)).toBe(WASM_HASH);
  });

  it("resolves a Stellar Asset Contract to nothing rather than to an error", async () => {
    const resolver = resolverAnswering({
      result: { entries: [{ xdr: ledgerEntry(xdr.ContractExecutable.contractExecutableStellarAsset()) }] },
    });
    expect(await resolver.resolve("testnet", CONTRACT_ID)).toBeUndefined();
  });

  it("resolves an address with no ledger entry to nothing", async () => {
    const resolver = resolverAnswering({ result: { entries: [] } });
    expect(await resolver.resolve("testnet", CONTRACT_ID)).toBeUndefined();
  });

  it("rejects a malformed contract id before making any request", async () => {
    let requested = false;
    const config = { get: (key: string) => (key === "stellarRpcUrlTestnet" ? RPC_URL : 5_000) };
    globalThis.fetch = (async () => {
      requested = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const resolver = new StellarRpcAddressResolver(config as never);
    await expect(resolver.resolve("testnet", "not-a-contract")).rejects.toThrow(MalformedContractIdError);
    expect(requested).toBe(false);
  });

  it("surfaces an RPC-level error rather than reading past it", async () => {
    const resolver = resolverAnswering({ error: { message: "method not found" } });
    await expect(resolver.resolve("testnet", CONTRACT_ID)).rejects.toThrow(/method not found/);
  });

  it("surfaces a transport failure", async () => {
    const resolver = resolverAnswering({}, { status: 503 });
    await expect(resolver.resolve("testnet", CONTRACT_ID)).rejects.toThrow(/503/);
  });

  it("refuses mainnet with no configured endpoint, instead of guessing one", async () => {
    const resolver = resolverAnswering({ result: { entries: [] } });
    await expect(resolver.resolve("mainnet", CONTRACT_ID)).rejects.toThrow(/No Soroban RPC endpoint/);
  });
});

describe("an upstream failure reaching the caller", () => {
  const KEYED_RPC_URL = "https://rpc.example/v1/provider-key-0123456789";

  it("answers 502 address_resolution_failed without the endpoint the resolver named", async () => {
    const config = { get: (key: string) => (key === "stellarRpcUrlTestnet" ? KEYED_RPC_URL : 5_000) };
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    const resolver = new StellarRpcAddressResolver(config as never);
    await expect(resolver.resolve("testnet", CONTRACT_ID)).rejects.toThrow(KEYED_RPC_URL);

    const controller = new ResultsController(
      { byHash: async () => ({}) } as never,
      { hasCompletedFirstPass: true } as never,
      resolver,
    );
    const refusal = await controller.queryByContract("testnet", CONTRACT_ID).then(
      () => undefined,
      (error: { getStatus(): number; getResponse(): unknown }) => error,
    );

    expect(refusal?.getStatus()).toBe(502);
    expect(refusal?.getResponse()).toMatchObject({ error: "address_resolution_failed" });
    expect(JSON.stringify(refusal?.getResponse())).not.toContain("rpc.example");
  });
});
