import Axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";

// baseURL is left unset here — the consuming app (clients/web) sets `AXIOS_INSTANCE.defaults.baseURL` once at
// startup, so this package stays environment-agnostic.
export const AXIOS_INSTANCE = Axios.create();

/** orval's custom mutator (see ../orval.config.ts's `override.mutator`). */
export const verifyApiClient = <T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
  const source = Axios.CancelToken.source();
  const promise = AXIOS_INSTANCE({ ...config, headers: withFileNameHeader(config), cancelToken: source.token }) as Promise<
    AxiosResponse<T>
  > & { cancel?: () => void };
  promise.cancel = () => {
    source.cancel("Query was cancelled");
  };
  return promise;
};

/**
 * `uploadSource`'s generated function (see src/generated/verify-api.ts) has no way to carry a per-call
 * `X-Filename` header.
 */
function withFileNameHeader(config: AxiosRequestConfig): AxiosRequestConfig["headers"] {
  if (typeof File !== "undefined" && config.data instanceof File && !config.headers?.["X-Filename"]) {
    return { ...config.headers, "X-Filename": config.data.name };
  }
  return config.headers;
}

export type ErrorType<Error> = AxiosError<Error>;
export type BodyType<BodyData> = BodyData;
