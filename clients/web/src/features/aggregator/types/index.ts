import type { AggregatedWasmStatus, QueryApiFailure } from "@scvs/sdk";

/** One lookup against query-svc, by hash or by address. */
export type LookupState =
  | { phase: "idle" }
  | { phase: "invalid" }
  | { phase: "loading" }
  | { phase: "answered"; status: AggregatedWasmStatus }
  | { phase: "empty"; status: AggregatedWasmStatus }
  | { phase: "failed"; failure: QueryApiFailure };
