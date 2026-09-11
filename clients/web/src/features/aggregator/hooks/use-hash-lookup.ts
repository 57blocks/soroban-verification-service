import type { QueryApiFailure } from "@scvs/sdk";
import { queryApi, transportFailureCopy } from "./query-api";
import { useAggregateLookup } from "./use-aggregate-lookup";
import type { LookupState } from "../types";

const WASM_HASH_RE = /^[a-fA-F0-9]{64}$/;

export const isWasmHash = (value: string): boolean => WASM_HASH_RE.test(value.trim());

/** Every trusted verifier's answer for one Wasm hash, as *this deployment* has it. */
export const useHashLookup = (wasmHash: string | null): LookupState & { refresh: () => void } => {
  const trimmed = wasmHash?.trim().toLowerCase() ?? null;
  const valid = trimmed !== null && trimmed !== "" && isWasmHash(trimmed);

  return useAggregateLookup(
    ["query-aggregate", "hash", trimmed],
    valid ? () => queryApi().registry.byHash(trimmed) : null,
    { enabled: valid, invalid: trimmed !== null && trimmed !== "" && !valid },
  );
};

/** Shared with the contract route: these codes are the transport's, not one route's. */
export const lookupFailureCopy = (failure: QueryApiFailure): string => transportFailureCopy(failure);
