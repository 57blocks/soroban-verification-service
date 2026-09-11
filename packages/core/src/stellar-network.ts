import type { Network } from "./enums.js";
import { checkUrl, normalizePolicy } from "./fetch-policy.js";

// How every `stellar` CLI invocation in this repo names the network it must reach.

/** The mainnet passphrase, a public constant of the Stellar network itself — not configuration, and not a secret. */
export const MAINNET_NETWORK_PASSPHRASE =
  "Public Global Stellar Network ; September 2015";

/**
 * The CLI dials this URL, so a wrong one must fail before it does: https-only, never a
 * loopback/private/link-local host.
 */
export function checkedMainnetRpcUrl(url: string): string {
  return checkUrl(normalizePolicy({ allowedSchemes: ["https:"] }), url).toString();
}

/** The network arguments for one `stellar` subcommand. */
export function stellarNetworkArgs(
  network: Network,
  mainnetRpcUrl?: string
): string[] {
  if (network === "mainnet" && mainnetRpcUrl) {
    return [
      "--rpc-url",
      checkedMainnetRpcUrl(mainnetRpcUrl),
      "--network-passphrase",
      MAINNET_NETWORK_PASSPHRASE,
    ];
  }
  return ["--network", network];
}
