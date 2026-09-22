import assert from "node:assert/strict";
import {
  buildFetchCommand,
  classifyFetchFailure,
  summarizeCommandFailure,
  type ChainReaderConfig,
} from "./chain-reader.js";
import type { CommandResult } from "./process.js";
import type { VerificationTarget } from "./target.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const MAINNET_TARGET: VerificationTarget = { network: "mainnet", contract_id: `C${"A".repeat(55)}` };
const TESTNET_TARGET: VerificationTarget = { network: "testnet", contract_id: `C${"A".repeat(55)}` };
const BASE_CONFIG: ChainReaderConfig = {
  stellarCliPath: "stellar",
  artifactDir: "/tmp/scvs-chain-reader-test",
  cliTimeoutMs: 5_000,
};
const MAINNET_RPC_URL = "https://mainnet.sorobanrpc.com";
const WASM_PATH = "/tmp/scvs-chain-reader-test/target.wasm";

// ── Which network arguments the CLI receives ───────────────────────────────────────────────────────
// These four moved here from `verification-svc`'s own spec, along with the reader. They were the only test
// either copy had, and they guarded one of the two services that make this call.

test("mainnet without a configured RPC URL keeps the CLI default (--network mainnet)", () => {
  const command = buildFetchCommand(MAINNET_TARGET, BASE_CONFIG, WASM_PATH);
  assert.ok(command.includes("--network"));
  assert.ok(command.includes("mainnet"));
  assert.equal(command.includes("--rpc-url"), false);
  assert.equal(command.includes("--network-passphrase"), false);
});

test("mainnet with a configured RPC URL passes --rpc-url and the passphrase, not --network", () => {
  const command = buildFetchCommand(MAINNET_TARGET, { ...BASE_CONFIG, mainnetRpcUrl: MAINNET_RPC_URL }, WASM_PATH);
  assert.ok(command.includes("--rpc-url"));
  // checkUrl normalises before the CLI sees the value — the trailing slash is its toString().
  assert.ok(command.includes(new URL(MAINNET_RPC_URL).toString()));
  assert.ok(command.includes("--network-passphrase"));
  assert.ok(command.includes("Public Global Stellar Network ; September 2015"));
  assert.equal(command.includes("--network"), false);
});

test("testnet keeps --network testnet even when an RPC URL is configured", () => {
  const command = buildFetchCommand(TESTNET_TARGET, { ...BASE_CONFIG, mainnetRpcUrl: MAINNET_RPC_URL }, WASM_PATH);
  assert.ok(command.includes("--network"));
  assert.ok(command.includes("testnet"));
  assert.equal(command.includes("--rpc-url"), false);
});

test("refuses a non-https or private-host mainnet URL before the CLI runs", () => {
  for (const badUrl of [
    "http://mainnet.sorobanrpc.com",
    "https://localhost:8443/",
    "https://10.0.0.5/",
    "https://169.254.169.254/",
  ]) {
    assert.throws(
      () => buildFetchCommand(MAINNET_TARGET, { ...BASE_CONFIG, mainnetRpcUrl: badUrl }, WASM_PATH),
      `${badUrl} must not reach the CLI`,
    );
  }
});

test("a target given by hash rather than id is fetched by --wasm-hash", () => {
  const command = buildFetchCommand({ network: "testnet", wasm_hash: "a".repeat(64) }, BASE_CONFIG, WASM_PATH);
  assert.ok(command.includes("--wasm-hash"));
  assert.ok(command.includes("a".repeat(64)));
  assert.equal(command.includes("--id"), false);
});

// ── How a failed fetch is read ─────────────────────────────────────────────────────────────────────
// Both copies kept these private, so neither was tested. They decide what the submitter is told, and the
// first of them decides whether the answer is a 404.

const failed = (over: Partial<CommandResult>): CommandResult => ({
  command: ["stellar"],
  exit_code: 1,
  stdout: "",
  stderr: "",
  timed_out: false,
  ...over,
});

test("only a missing target is not_found; anything else is a lookup failure", () => {
  assert.equal(classifyFetchFailure(failed({ stderr: "Contract not found" })), "not_found");
  assert.equal(classifyFetchFailure(failed({ stdout: "the ledger entry does not exist" })), "not_found");
  assert.equal(classifyFetchFailure(failed({ stderr: "connection refused" })), "chain_lookup_failed");
  assert.equal(classifyFetchFailure(failed({ error: "spawn ENOENT" })), "chain_lookup_failed");
});

test("the summary prefers the spawn error, then stderr, then stdout, and always says something", () => {
  assert.equal(summarizeCommandFailure(failed({ error: "spawn ENOENT", stderr: "ignored" })), "spawn ENOENT");
  assert.equal(summarizeCommandFailure(failed({ stderr: " boom ", stdout: "ignored" })), "boom");
  assert.equal(summarizeCommandFailure(failed({ stdout: "only stdout" })), "only stdout");
  assert.equal(summarizeCommandFailure(failed({})), "Stellar CLI command failed.");
});

// CLI output reaches an API response, so it is bounded. 500 characters plus the ellipsis.
test("a long failure is truncated", () => {
  const summary = summarizeCommandFailure(failed({ stderr: "x".repeat(900) }));
  assert.equal(summary.length, 503);
  assert.ok(summary.endsWith("..."));
});
