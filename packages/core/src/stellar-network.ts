import type { Network } from "./enums.js";
import { checkUrl, normalizePolicy } from "./fetch-policy.js";

export const MAINNET_NETWORK_PASSPHRASE =
  "Public Global Stellar Network ; September 2015";

export function checkedMainnetRpcUrl(url: string): string {
  return checkUrl(normalizePolicy({ allowedSchemes: ["https:"] }), url).toString();
}

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
