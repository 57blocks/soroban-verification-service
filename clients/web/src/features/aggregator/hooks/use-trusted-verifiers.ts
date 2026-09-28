import { useQuery } from "@tanstack/react-query";
import { queryApiFailureOf, type PeerTrustedVerifiersList, type QueryApiFailure } from "soroban-verification-client";
import { queryApi } from "./query-api";

export type TrustedVerifiersState = {
  list: PeerTrustedVerifiersList | null;
  isLoading: boolean;
  failure: QueryApiFailure | null;
};

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
