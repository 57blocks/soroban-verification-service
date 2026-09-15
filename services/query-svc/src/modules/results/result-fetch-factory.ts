import type { FetchPolicy } from "@scvs/core/fetch-policy";

/**
 * DI token for the function `SoveClientFactory` hands `newClient` as `fetchFactory`. A provider token rather
 * than a direct `createPinnedFetch` import in `client-factory.service.ts` — the same shape `ADDRESS_RESOLVER`
 * (results.module.ts) uses — so the binding in `aggregation.module.ts` is the one place that decides which
 * transport this service actually uses.
 */
export const RESULT_FETCH_FACTORY = Symbol("RESULT_FETCH_FACTORY");

export type ResultFetchFactory = (policy: FetchPolicy) => typeof fetch;
