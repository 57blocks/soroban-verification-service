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

/** Node truncates above this instead of honouring it — see the constant's comment in http-timeouts.ts. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** A server is cheap and never listens here — only the three properties are under test. */
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
  // This is the 502: a balancer that reuses a connection Node has already closed has nothing to send it to.
  assert.ok(
    HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs > FRONTING_PROXY_IDLE_TIMEOUT_MS,
    `keep-alive ${HTTP_TIMEOUT_DEFAULTS.keepAliveTimeoutMs}ms must exceed the proxy's ${FRONTING_PROXY_IDLE_TIMEOUT_MS}ms`,
  );
});

test("a keep-alive at or under the proxy's idle timeout is refused, not merely discouraged", () => {
  // A well-formed override that silently reintroduces the 502. The default being correct is not enough.
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
  // orchestrator-svc's listener is loopback-only, and a self-hoster may expose the port directly. Neither
  // should inherit this deployment's ALB as a constraint.
  const s = server();
  applyHttpServerTimeouts(s, { ...VALID, frontingProxyIdleTimeoutMs: 0, keepAliveTimeoutMs: 5_000 });
  assert.equal(s.keepAliveTimeout, 5_000);
});

test("no ordering is required between the request and headers deadlines", () => {
  // Measured: the two are independent and a stalled head is closed at whichever is SHORTER — neither makes
  // the other unreachable. This module refused `request < headers` on the opposite belief until 2026-09-14.
  const s = server();
  applyHttpServerTimeouts(s, { ...VALID, requestTimeoutMs: 600, headersTimeoutMs: 3_000 });
  assert.equal(s.requestTimeout, 600);
  assert.equal(s.headersTimeout, 3_000);
});

test("a headers deadline under the keep-alive deadline is allowed", () => {
  // Also measured: Node times headers from the first byte of a request, not from when a connection goes idle,
  // so a short headers deadline does not break reuse of a long-lived idle connection. The shipped defaults
  // are exactly this shape, so refusing it would refuse our own configuration.
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
  // Measured: Node does NOT collapse these to ~1 ms the way setTimeout's overflow rule does — it truncates to
  // the ceiling, so a 24-day keep-alive is what an operator actually gets. Either way the number they wrote
  // stops applying, which is the thing this module promises.
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

console.log("HTTP server timeouts: 13 cases passed");
