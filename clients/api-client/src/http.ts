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
 * Fills `uploadSource`'s `X-Filename` from the `File` being sent, so no caller has to. The generated function can
 * take the header itself (`headers: true` in `orval.config.ts`); this only supplies it when none was passed, and
 * matches the name case-insensitively because the spec spells it `x-filename` — a passed one is never doubled.
 */
function withFileNameHeader(config: AxiosRequestConfig): AxiosRequestConfig["headers"] {
  const passed = Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === "x-filename");
  if (typeof File !== "undefined" && config.data instanceof File && !passed) {
    return { ...config.headers, "X-Filename": config.data.name };
  }
  return config.headers;
}

export type ErrorType<Error> = AxiosError<Error>;
export type BodyType<BodyData> = BodyData;
