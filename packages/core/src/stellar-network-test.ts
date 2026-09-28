import assert from "node:assert/strict";
import { FetchPolicyError } from "./fetch-policy.js";
import {
  MAINNET_NETWORK_PASSPHRASE,
  checkedMainnetRpcUrl,
  stellarNetworkArgs,
} from "./stellar-network.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const RPC = "https://mainnet.sorobanrpc.com/";

test("mainnet with a configured endpoint never says --network", () => {
  const args = stellarNetworkArgs("mainnet", RPC);
  assert.deepEqual(args, [
    "--rpc-url",
    RPC,
    "--network-passphrase",
    MAINNET_NETWORK_PASSPHRASE,
  ]);
  assert.equal(args.includes("--network"), false);
});

test("the endpoint and the passphrase always travel together", () => {
  const args = stellarNetworkArgs("mainnet", RPC);
  assert.equal(
    args.includes("--rpc-url"),
    args.includes("--network-passphrase")
  );
});

test("testnet keeps the built-in entry, which has a real endpoint", () => {
  assert.deepEqual(stellarNetworkArgs("testnet"), ["--network", "testnet"]);
  assert.deepEqual(stellarNetworkArgs("testnet", RPC), ["--network", "testnet"]);
});

test("mainnet with no configured endpoint falls back to the CLI's own loud failure", () => {
  assert.deepEqual(stellarNetworkArgs("mainnet"), ["--network", "mainnet"]);
  assert.deepEqual(stellarNetworkArgs("mainnet", ""), ["--network", "mainnet"]);
});

test("a non-https or private endpoint is refused before the CLI dials it", () => {
  assert.throws(() => checkedMainnetRpcUrl("http://mainnet.sorobanrpc.com"), FetchPolicyError);
  assert.throws(() => checkedMainnetRpcUrl("https://127.0.0.1:8000"), FetchPolicyError);
  assert.throws(() => checkedMainnetRpcUrl("not-a-url"), FetchPolicyError);
  assert.throws(() => stellarNetworkArgs("mainnet", "http://rpc.example.com"), FetchPolicyError);
});

console.log("stellar-network: all cases passed");
