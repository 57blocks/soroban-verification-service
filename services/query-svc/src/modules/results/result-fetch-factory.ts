import type { FetchPolicy } from "@scvs/core/fetch-policy";

export const RESULT_FETCH_FACTORY = Symbol("RESULT_FETCH_FACTORY");

export type ResultFetchFactory = (policy: FetchPolicy) => typeof fetch;
