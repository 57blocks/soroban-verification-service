import type { AggregatedWasmStatus, QueryApiFailure } from "soroban-verification-client";

export type LookupState =
  | { phase: "idle" }
  | { phase: "invalid" }
  | { phase: "loading" }
  | { phase: "answered"; status: AggregatedWasmStatus }
  | { phase: "empty"; status: AggregatedWasmStatus }
  | { phase: "failed"; failure: QueryApiFailure };
