/** The chain reader's command construction: which network arguments the `stellar` CLI receives. */
import type { VerificationTarget } from "@scvs/core";
import {
  buildFetchCommand,
  type ChainReaderConfig,
} from "../src/modules/preflight/chain-reader";

const MAINNET_TARGET: VerificationTarget = {
  network: "mainnet",
  contract_id: `C${"A".repeat(55)}`,
};
const TESTNET_TARGET: VerificationTarget = {
  network: "testnet",
  contract_id: `C${"A".repeat(55)}`,
};
const BASE_CONFIG: ChainReaderConfig = {
  stellarCliPath: "stellar",
  artifactDir: "/tmp/scvs-chain-reader-spec",
  cliTimeoutMs: 5_000,
};
const MAINNET_RPC_URL = "https://mainnet.sorobanrpc.com";
const WASM_PATH = "/tmp/scvs-chain-reader-spec/target.wasm";

it("mainnet without a configured RPC URL keeps the CLI default (--network mainnet)", () => {
  const command = buildFetchCommand(MAINNET_TARGET, BASE_CONFIG, WASM_PATH);

  expect(command).toContain("--network");
  expect(command).toContain("mainnet");
  expect(command).not.toContain("--rpc-url");
  expect(command).not.toContain("--network-passphrase");
});

it("mainnet with a configured RPC URL passes --rpc-url and the passphrase, not --network", () => {
  const command = buildFetchCommand(
    MAINNET_TARGET,
    { ...BASE_CONFIG, mainnetRpcUrl: MAINNET_RPC_URL },
    WASM_PATH
  );

  expect(command).toContain("--rpc-url");
  // checkUrl normalises before the CLI sees the value — the trailing slash is its toString().
  expect(command).toContain(new URL(MAINNET_RPC_URL).toString());
  expect(command).toContain("--network-passphrase");
  expect(command).toContain("Public Global Stellar Network ; September 2015");
  expect(command).not.toContain("--network");
});

it("testnet keeps --network testnet even when an RPC URL is configured", () => {
  const command = buildFetchCommand(
    TESTNET_TARGET,
    { ...BASE_CONFIG, mainnetRpcUrl: MAINNET_RPC_URL },
    WASM_PATH
  );

  expect(command).toContain("--network");
  expect(command).toContain("testnet");
  expect(command).not.toContain("--rpc-url");
});

it("refuses a non-https or private-host mainnet URL before the CLI runs", () => {
  for (const badUrl of [
    "http://mainnet.sorobanrpc.com",
    "https://localhost:8443/",
    "https://10.0.0.5/",
    "https://169.254.169.254/",
  ]) {
    expect(() =>
      buildFetchCommand(
        MAINNET_TARGET,
        { ...BASE_CONFIG, mainnetRpcUrl: badUrl },
        WASM_PATH
      )
    ).toThrow();
  }
});
