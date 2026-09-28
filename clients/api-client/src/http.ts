import Axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";

export const AXIOS_INSTANCE = Axios.create();

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

function withFileNameHeader(config: AxiosRequestConfig): AxiosRequestConfig["headers"] {
  const passed = Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === "x-filename");
  if (typeof File !== "undefined" && config.data instanceof File && !passed) {
    return { ...config.headers, "X-Filename": config.data.name };
  }
  return config.headers;
}

export type ErrorType<Error> = AxiosError<Error>;
export type BodyType<BodyData> = BodyData;
