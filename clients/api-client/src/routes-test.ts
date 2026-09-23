import assert from "node:assert/strict";
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from "axios";
import { AXIOS_INSTANCE } from "./http.js";
import { getGetBuildLogQueryKey } from "./generated/verify-api.js";
import { getBuildLogWithToken, jobEventsPath } from "./routes.js";

/**
 * Exercised through axios's own adapter seam: the real request pipeline — the mutator, header merging,
 * `baseURL` — runs, and only the transport is replaced, so there is no network and nothing mocked above it.
 */

let captured: InternalAxiosRequestConfig | undefined;
AXIOS_INSTANCE.defaults.adapter = async (config) => {
  captured = config;
  return { data: "cargo build --release\nFinished", status: 200, statusText: "OK", headers: {}, config };
};

const header = (config: AxiosRequestConfig | undefined, name: string): unknown => {
  const headers = config?.headers as { get?: (n: string) => unknown } & Record<string, unknown>;
  return typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
};

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  captured = undefined;
  AXIOS_INSTANCE.defaults.baseURL = undefined;
  await fn();
  console.log(`ok - ${name}`);
}

const JOB = "0f8b3a52-6c1e-4d7a-9e2b-5a4c3d2e1f00";

await test("the build log is a GET to the job's log route, carrying the token as the header", async () => {
  await getBuildLogWithToken(JOB, "token-a");
  assert.equal(captured?.method, "get");
  assert.equal(captured?.url, `/api/verification/v1/verifications/${JOB}/log`);
  assert.equal(header(captured, "X-Build-Log-Token"), "token-a");
});

// The path is not an independent choice: it is the route orval generated from `openapi.json`. If the
// document moves the route and the client is regenerated, this is where the hand-written copy is caught.
await test("the log path is the one the OpenAPI document declares", async () => {
  await getBuildLogWithToken(JOB, "token-a");
  assert.equal(captured?.url, getGetBuildLogQueryKey(JOB)[0]);
});

// The environment-agnostic contract: the token comes from the caller, and nothing here decides it.
await test("the token sent is the one passed, per call", async () => {
  await getBuildLogWithToken(JOB, "token-a");
  assert.equal(header(captured, "X-Build-Log-Token"), "token-a");
  await getBuildLogWithToken(JOB, "token-b");
  assert.equal(header(captured, "X-Build-Log-Token"), "token-b");
});

await test("it honours the base URL the app configured, rather than choosing one", async () => {
  AXIOS_INSTANCE.defaults.baseURL = "https://dev.sv.example";
  await getBuildLogWithToken(JOB, "t");
  assert.equal(captured?.baseURL, "https://dev.sv.example");
});

// The console reads `.data`; returning the body alone would compile against a mock and break against axios.
await test("it resolves to the axios response, whose data is the log text", async () => {
  const response = await getBuildLogWithToken(JOB, "t");
  assert.equal(response.status, 200);
  assert.equal(response.data, "cargo build --release\nFinished");
});

await test("an abort signal is passed through", async () => {
  const controller = new AbortController();
  await getBuildLogWithToken(JOB, "t", controller.signal);
  assert.equal(captured?.signal, controller.signal);
});

// No generated counterpart exists for this one — SSE is not in the document — so it is pinned to its sibling.
await test("the event stream lives beside the log, under the same job", () => {
  assert.equal(jobEventsPath(JOB), `/api/verification/v1/verifications/${JOB}/events`);
  assert.equal(jobEventsPath(JOB).replace(/\/events$/, "/log"), getGetBuildLogQueryKey(JOB)[0]);
});
