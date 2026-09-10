import { useQuery } from "@tanstack/react-query";
import { queryApiFailureOf, type AggregatedWasmStatus } from "@scvs/sdk";
import type { LookupState } from "../types";

/**
 * One subject looked up in this deployment's aggregate. The caller supplies the question as a thunk over the
 * SDK client, so this hook holds the states and knows nothing about routes.
 */
export const useAggregateLookup = (
  queryKey: readonly unknown[],
  ask: (() => Promise<AggregatedWasmStatus>) | null,
  { enabled, invalid }: { enabled: boolean; invalid: boolean },
): LookupState & { refresh: () => void } => {
  const query = useQuery({
    queryKey,
    enabled: enabled && ask !== null,
    retry: false,
    queryFn: async () => ask!(),
  });

  // `refetch`, not a nonce in the key: an unchanged subject must re-ask, but minting a key per press makes
  // every lookup a cache miss.
  const refresh = () => {
    if (query.isFetched) void query.refetch();
  };

  if (invalid) return { phase: "invalid", refresh };
  if (!enabled || ask === null) return { phase: "idle", refresh };
  if (query.isPending) return { phase: "loading", refresh };
  if (query.isError) return { phase: "failed", failure: queryApiFailureOf(query.error), refresh };

  const status = query.data;
  if (status.source_code_verifications.length > 0) return { phase: "answered", status, refresh };
  return { phase: "empty", status, refresh };
};
