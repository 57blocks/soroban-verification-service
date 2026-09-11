import type { Network } from "@scvs/core";

export const ADDRESS_RESOLVER = Symbol("ADDRESS_RESOLVER");

/** A contract ID that is not a contract ID at all — the caller's mistake, not the ledger's. */
export class MalformedContractIdError extends Error {
  constructor(contractId: string) {
    super(`${contractId} is not a valid contract address`);
    this.name = "MalformedContractIdError";
  }
}

export interface AddressResolver {
  /** The Wasm hash a contract currently holds, read from the ledger. */
  resolve(network: Network, contractId: string): Promise<string | undefined>;
}
