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
  requestTimeoutMs: 300_000,
  headersTimeoutMs: 70_000,
  keepAliveTimeoutMs: 65_000,
};

/** A server is cheap and never listens here — only the three properties are under test. */
const server = () => createServer();

test("applies all three deadlines to the server", () => {
  const s = server();
  applyHttpServerTimeouts(s, VALID);
  assert.equal(s.requestTimeout, 300_000);
  assert.equal(s.headersTimeout, 70_000);
  assert.equal(s.keepAliveTimeout, 65_000);
});

test("the shipped defaults are themselves a valid combination", () => {
  // Without this, a future edit to HTTP_TIMEOUT_DEFAULTS could ship a combination that only fails at boot.
  const s = server();
  applyHttpServerTimeouts(s, HTTP_TIMEOUT_DEFAULTS);
  assert.equal(s.keepAliveTimeout, HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs);
});

test("the default keep-alive outlives the fronting proxy's idle timeout", () => {
  // This is the 502: a balancer that reuses a connection Node has already closed has nothing to send it to.
  assert.ok(
    HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs > FRONTING_PROXY_IDLE_TIMEOUT_MS,
    `keep-alive ${HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs}ms must exceed the proxy's ${FRONTING_PROXY_IDLE_TIMEOUT_MS}ms`,
  );
});

test("zero is refused on every field — it is Node's spelling of no deadline", () => {
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

test("the headers deadline must outlast the keep-alive deadline", () => {
  assert.throws(
    () =>
      applyHttpServerTimeouts(server(), {
        ...VALID,
        headersTimeoutMs: 65_000,
        keepAliveTimeoutMs: 65_000,
      }),
    /headersTimeoutMs \(65000\) must be greater than keepAliveTimeoutMs \(65000\)/,
  );
});

test("the request deadline must not undercut the headers deadline", () => {
  assert.throws(
    () => applyHttpServerTimeouts(server(), { ...VALID, requestTimeoutMs: 69_999 }),
    /requestTimeoutMs \(69999\) must be at least headersTimeoutMs \(70000\)/,
  );
});

test("equal request and headers deadlines are allowed", () => {
  // The boundary is legal: the head may consume the entire request window when there is no body to follow.
  const s = server();
  applyHttpServerTimeouts(s, { ...VALID, requestTimeoutMs: 70_000 });
  assert.equal(s.requestTimeout, 70_000);
});

test("a rejected combination leaves the server untouched", () => {
  // Nothing may be half-applied: a boot that throws must not leave one deadline set and two at Node's defaults.
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

console.log("HTTP server timeouts: 9 cases passed");
