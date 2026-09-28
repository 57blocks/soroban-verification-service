import type { Network } from "@scvs/core";

export const ADDRESS_RESOLVER = Symbol("ADDRESS_RESOLVER");

export class MalformedContractIdError extends Error {
  constructor(contractId: string) {
    super(`${contractId} is not a valid contract address`);
    this.name = "MalformedContractIdError";
  }
}

export interface AddressResolver {
  resolve(network: Network, contractId: string): Promise<string | undefined>;
}
