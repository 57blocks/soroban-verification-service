import type { AxiosResponse } from "axios";
import { verifyApiClient } from "./http.js";

/**
 * The two verification-svc routes the generated client cannot serve, written by hand so their paths and
 * headers live in this package rather than in whichever console feature happens to need them.
 *
 * - **The build log** is in `openapi.json`, with `x-build-log-token` declared `in: header, required: true`,
 *   but orval's generated `getBuildLog(jobId, signal)` has no way to send a header. It compiles and 401s.
 * - **The job's event stream** is not in `openapi.json` at all: server-sent events have no place in it, so
 *   there is nothing to generate.
 *
 * The token is an **argument**, never read here. This package is deliberately environment-agnostic — the
 * console sets `AXIOS_INSTANCE.defaults.baseURL` at startup and keeps the token in its own `localStorage` —
 * and taking the value from the caller is what keeps it that way. Reading storage here is the thing to avoid,
 * not accepting a header.
 */

/** What orval would have generated for `GET /verifications/{job_id}/log` had it carried header parameters. */
export const getBuildLogWithToken = (
  jobId: string,
  token: string,
  signal?: AbortSignal,
): Promise<AxiosResponse<string>> =>
  verifyApiClient<string>({
    url: `/api/verification/v1/verifications/${jobId}/log`,
    method: "GET",
    headers: { "X-Build-Log-Token": token },
    signal,
  });

/**
 * The path of a job's server-sent event stream. A path and not a URL: `EventSource` does not go through
 * axios, so the caller joins it to the origin it configured, exactly as it does for `baseURL`.
 */
export const jobEventsPath = (jobId: string): string => `/api/verification/v1/verifications/${jobId}/events`;
