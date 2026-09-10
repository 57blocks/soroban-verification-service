import { useQuery } from "@tanstack/react-query";
import { queryApiFailureOf, type PeerTrustedVerifiersList, type QueryApiFailure } from "@scvs/sdk";
import { queryApi } from "./query-api";

export type TrustedVerifiersState = {
  /** The consumer shape: this page reads a list, and reading one tolerates more than publishing one. */
  list: PeerTrustedVerifiersList | null;
  isLoading: boolean;
  failure: QueryApiFailure | null;
};

/**
 * The Trusted Verifiers List as a page in its own right — the set of verifiers this deployment aggregates
 * across, and therefore the set every answer on the other tabs was assembled from.
 */
export const useTrustedVerifiers = (): TrustedVerifiersState => {
  const query = useQuery({
    queryKey: ["trusted-verifiers"],
    retry: false,
    staleTime: Infinity,
    queryFn: async () => queryApi().verifiers(),
  });

  return {
    list: query.data ?? null,
    isLoading: query.isPending,
    failure: query.isError ? queryApiFailureOf(query.error) : null,
  };
};
