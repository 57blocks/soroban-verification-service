import assert from "node:assert/strict";
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from "axios";
import { AXIOS_INSTANCE } from "./http.js";
import { getBuildLog, getGetBuildLogQueryKey, uploadSource } from "./generated/verify-api.js";
import { jobEventsPath } from "./routes.js";

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

await test("the generated getBuildLog sends the token the route requires", async () => {
  await getBuildLog(JOB, { "x-build-log-token": "token-a" });
  assert.equal(captured?.method, "get");
  assert.equal(captured?.url, `/api/verification/v1/verifications/${JOB}/log`);
  assert.equal(header(captured, "x-build-log-token"), "token-a");
});

await test("the token sent is the one passed, per call", async () => {
  await getBuildLog(JOB, { "x-build-log-token": "token-a" });
  assert.equal(header(captured, "x-build-log-token"), "token-a");
  await getBuildLog(JOB, { "x-build-log-token": "token-b" });
  assert.equal(header(captured, "x-build-log-token"), "token-b");
});

await test("it honours the base URL the app configured, rather than choosing one", async () => {
  AXIOS_INSTANCE.defaults.baseURL = "https://dev.sv.example";
  await getBuildLog(JOB, { "x-build-log-token": "t" });
  assert.equal(captured?.baseURL, "https://dev.sv.example");
});

await test("it resolves to the axios response, whose data is the log text", async () => {
  const response = await getBuildLog(JOB, { "x-build-log-token": "t" });
  assert.equal(response.status, 200);
  assert.equal(response.data, "cargo build --release\nFinished");
});

await test("the uploaded file's name fills X-Filename when the caller passes none", async () => {
  await uploadSource(new File(["x"], "source.tar.gz"));
  assert.equal(header(captured, "X-Filename"), "source.tar.gz");
});

await test("a filename the caller passes is kept, and not doubled by the mutator", async () => {
  await uploadSource(new File(["x"], "from-the-file.tar.gz"), { "x-filename": "chosen.tar.gz" });
  assert.equal(header(captured, "x-filename"), "chosen.tar.gz");
  const names = Object.keys((captured?.headers ?? {}) as object).filter((n) => n.toLowerCase() === "x-filename");
  assert.equal(names.length, 1);
});

await test("the event stream lives beside the log, under the same job", () => {
  assert.equal(jobEventsPath(JOB), `/api/verification/v1/verifications/${JOB}/events`);
  assert.equal(jobEventsPath(JOB).replace(/\/events$/, "/log"), getGetBuildLogQueryKey(JOB)[0]);
});
