import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  applyHttpServerTimeouts,
  FRONTING_PROXY_IDLE_TIMEOUT_MS,
  HTTP_TIMEOUT_DEFAULTS,
  HttpTimeoutConfigError,
  type HttpServerTimeouts,
} from "./http-timeouts.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const VALID: HttpServerTimeouts = {
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 65_000,
  frontingProxyIdleTimeoutMs: FRONTING_PROXY_IDLE_TIMEOUT_MS,
};

const MAX_TIMEOUT_MS = 2_147_483_647;

const server = () => createServer();

test("applies all three deadlines to the server", () => {
  const s = server();
  applyHttpServerTimeouts(s, VALID);
  assert.equal(s.requestTimeout, 30_000);
  assert.equal(s.headersTimeout, 10_000);
  assert.equal(s.keepAliveTimeout, 65_000);
});

test("the shipped defaults are themselves a valid combination", () => {
  const s = server();
  applyHttpServerTimeouts(s, HTTP_TIMEOUT_DEFAULTS);
  assert.equal(s.keepAliveTimeout, HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs);
});

test("the default keep-alive outlives the fronting proxy's idle timeout", () => {
  assert.ok(
    HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs > FRONTING_PROXY_IDLE_TIMEOUT_MS,
    `keep-alive ${HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs}ms must exceed the proxy's ${FRONTING_PROXY_IDLE_TIMEOUT_MS}ms`,
  );
});

test("a keep-alive at or under the proxy's idle timeout is refused, not merely discouraged", () => {
  for (const keepAliveTimeoutMs of [1, 5_000, 30_000, FRONTING_PROXY_IDLE_TIMEOUT_MS]) {
    assert.throws(
      () => applyHttpServerTimeouts(server(), { ...VALID, keepAliveTimeoutMs }),
      /must exceed the fronting proxy's idle timeout/,
      `keepAliveTimeoutMs = ${keepAliveTimeoutMs} must be refused`,
    );
  }
  const s = server();
  applyHttpServerTimeouts(s, { ...VALID, keepAliveTimeoutMs: FRONTING_PROXY_IDLE_TIMEOUT_MS + 1 });
  assert.equal(s.keepAliveTimeout, FRONTING_PROXY_IDLE_TIMEOUT_MS + 1);
});

test("a server with nothing in front of it declares 0 and keeps a short keep-alive", () => {
  const s = server();
  applyHttpServerTimeouts(s, { ...VALID, frontingProxyIdleTimeoutMs: 0, keepAliveTimeoutMs: 5_000 });
  assert.equal(s.keepAliveTimeout, 5_000);
});

test("no ordering is required between the request and headers deadlines", () => {
  const s = server();
  applyHttpServerTimeouts(s, { ...VALID, requestTimeoutMs: 600, headersTimeoutMs: 3_000 });
  assert.equal(s.requestTimeout, 600);
  assert.equal(s.headersTimeout, 3_000);
});

test("a headers deadline under the keep-alive deadline is allowed", () => {
  const s = server();
  applyHttpServerTimeouts(s, { ...VALID, headersTimeoutMs: 10_000, keepAliveTimeoutMs: 65_000 });
  assert.equal(s.headersTimeout, 10_000);
  assert.equal(s.keepAliveTimeout, 65_000);
});

test("zero is refused on every deadline — it is Node's spelling of no deadline", () => {
  for (const field of ["requestTimeoutMs", "headersTimeoutMs", "keepAliveTimeoutMs"] as const) {
    assert.throws(
      () => applyHttpServerTimeouts(server(), { ...VALID, [field]: 0 }),
      (error: Error) => error instanceof HttpTimeoutConfigError && error.message.includes(field),
      `${field} = 0 must be refused`,
    );
  }
});

test("negative, fractional and non-finite values are refused", () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => applyHttpServerTimeouts(server(), { ...VALID, keepAliveTimeoutMs: bad }),
      HttpTimeoutConfigError,
      `keepAliveTimeoutMs = ${bad} must be refused`,
    );
  }
});

test("a value above Node's timer ceiling is refused rather than silently truncated", () => {
  for (const field of ["requestTimeoutMs", "headersTimeoutMs", "keepAliveTimeoutMs"] as const) {
    assert.throws(
      () => applyHttpServerTimeouts(server(), { ...VALID, [field]: MAX_TIMEOUT_MS + 1 }),
      (error: Error) =>
        error instanceof HttpTimeoutConfigError && /Node's timer ceiling/.test(error.message),
      `${field} above the ceiling must be refused`,
    );
  }
  assert.throws(
    () => applyHttpServerTimeouts(server(), { ...VALID, frontingProxyIdleTimeoutMs: MAX_TIMEOUT_MS + 1 }),
    HttpTimeoutConfigError,
  );
});

test("the ceiling itself is accepted — the bound is exclusive above it, not a round-number guess", () => {
  const s = server();
  applyHttpServerTimeouts(s, { ...VALID, requestTimeoutMs: MAX_TIMEOUT_MS });
  assert.equal(s.requestTimeout, MAX_TIMEOUT_MS);
});

test("a negative fronting-proxy timeout is refused, though zero is not", () => {
  assert.throws(
    () => applyHttpServerTimeouts(server(), { ...VALID, frontingProxyIdleTimeoutMs: -1 }),
    /frontingProxyIdleTimeoutMs must be a whole number/,
  );
});

test("a rejected combination leaves the server untouched", () => {
  const s = server();
  const before = {
    requestTimeout: s.requestTimeout,
    headersTimeout: s.headersTimeout,
    keepAliveTimeout: s.keepAliveTimeout,
  };
  assert.throws(() => applyHttpServerTimeouts(s, { ...VALID, keepAliveTimeoutMs: 0 }));
  assert.deepEqual(
    {
      requestTimeout: s.requestTimeout,
      headersTimeout: s.headersTimeout,
      keepAliveTimeout: s.keepAliveTimeout,
    },
    before,
  );
});

console.log("HTTP server timeouts: 13 cases passed");
