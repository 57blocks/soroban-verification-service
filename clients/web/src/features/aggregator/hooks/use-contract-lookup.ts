import type { Network, QueryApiFailure } from "soroban-verification-client";
import { CONTRACT_ID_SHAPE } from "@/lib/field-shapes";
import { queryApi } from "./query-api";
import { useAggregateLookup } from "./use-aggregate-lookup";
import { lookupFailureCopy } from "./use-hash-lookup";
import type { LookupState } from "../types";

/** Uppercased first, because this page sends the uppercased value — see `CONTRACT_ID_SHAPE`. */
export const isContractId = (value: string): boolean => CONTRACT_ID_SHAPE.test(value.trim().toUpperCase());

/** Every trusted verifier's answer for whatever Wasm a contract address currently holds. */
export const useContractLookup = (
  network: Network,
  contractId: string | null,
): LookupState & { refresh: () => void } => {
  const trimmed = contractId?.trim().toUpperCase() ?? null;
  const valid = trimmed !== null && trimmed !== "" && isContractId(trimmed);

  return useAggregateLookup(
    ["query-aggregate", "contract", network, trimmed],
    valid ? () => queryApi().registry.byContract(network, trimmed) : null,
    { enabled: valid, invalid: trimmed !== null && trimmed !== "" && !valid },
  );
};

/** What the reader is told for each way this route refuses. */
export const contractFailureCopy = (failure: QueryApiFailure): string => {
  switch (failure.code) {
    case "invalid_network":
      return "That network is not one the query API serves.";
    case "invalid_contract_id":
      return `That is not a well-formed contract address. ${failure.message}`;
    case "contract_not_found":
      return "No Wasm-executable contract is deployed at that address on this network. Nothing was queried.";
    case "address_resolution_failed":
      return `The ledger could not be reached, so the address was never resolved — this says nothing about whether the contract is verified. ${failure.message}`;
    default:
      return lookupFailureCopy(failure);
  }
};
