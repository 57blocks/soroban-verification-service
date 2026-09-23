import axios, { AxiosError } from "axios";

/**
 * The verification API origin, with any trailing slash removed so a path from `@scvs/verify-api-client`
 * (`jobEventsPath`, for the one route that does not go through axios) can be joined onto it.
 */
export const getApiBase = () => import.meta.env.VITE_VERIFY_API_URL?.replace(/\/+$/, "");

export const isApiBaseConfigured = () => getApiBase() !== undefined;

/** The query API's origin, for the aggregator page — the only thing here that talks to query-svc. */
export const getQueryApiBase = () =>
  import.meta.env.VITE_QUERY_API_URL?.replace(/\/+$/, "") ?? "";

export const errorMessage = (error: unknown, fallback: string) => {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError<{ message?: string; error?: string }>;
    return err.response?.data?.message || err.response?.data?.error || err.message || fallback;
  }
  return error instanceof Error ? error.message : fallback;
};

export const isHttpError = (error: unknown): error is AxiosError => axios.isAxiosError(error);
