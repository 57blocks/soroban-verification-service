import type { QueryApiFailure } from "soroban-verification-client";
import { isHexSha256 } from "@/lib/field-shapes";
import { queryApi, transportFailureCopy } from "./query-api";
import { useAggregateLookup } from "./use-aggregate-lookup";
import type { LookupState } from "../types";

export const isWasmHash = isHexSha256;

export const useHashLookup = (wasmHash: string | null): LookupState & { refresh: () => void } => {
  const trimmed = wasmHash?.trim().toLowerCase() ?? null;
  const valid = trimmed !== null && trimmed !== "" && isWasmHash(trimmed);

  return useAggregateLookup(
    ["query-aggregate", "hash", trimmed],
    valid ? () => queryApi().registry.byHash(trimmed) : null,
    { enabled: valid, invalid: trimmed !== null && trimmed !== "" && !valid },
  );
};

export const lookupFailureCopy = (failure: QueryApiFailure): string => transportFailureCopy(failure);
