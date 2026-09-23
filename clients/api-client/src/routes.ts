/**
 * The verification-svc routes the generator cannot produce, so their paths live in this package rather than in
 * whichever console feature needs them. There is one.
 *
 * **The job's event stream** is not in `openapi.json` at all: server-sent events have no place in an OpenAPI
 * document, so there is nothing for orval to generate.
 *
 * Not here, deliberately: the build log. It needs a request header, and it is generated — `orval.config.ts`
 * turns on `headers: true`, so `getBuildLog(jobId, headers, signal)` takes a typed `x-build-log-token`. A
 * route belongs in this file only when the document cannot describe it.
 */

/**
 * The path of a job's server-sent event stream. A path and not a URL: `EventSource` does not go through
 * axios, so the caller joins it to the origin it configured, exactly as it does for `baseURL`.
 */
export const jobEventsPath = (jobId: string): string => `/api/verification/v1/verifications/${jobId}/events`;
