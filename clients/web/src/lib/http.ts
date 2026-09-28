import axios, { AxiosError } from "axios";

export const getApiBase = () => import.meta.env.VITE_VERIFY_API_URL?.replace(/\/+$/, "");

export const isApiBaseConfigured = () => getApiBase() !== undefined;

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
