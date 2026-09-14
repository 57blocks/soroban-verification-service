import type { Server } from "node:http";

/**
 * The three `http.Server` deadlines every serving entrypoint sets after `listen()`. Left unset, Node supplies
 * its own — which is not a neutral default: `keepAliveTimeout` is 5 s, below every load balancer's idle
 * timeout, and that mismatch is what produces intermittent 502s under an ALB.
 */
export type HttpServerTimeouts = {
  /** From the first byte of a request to the last byte of its body. Bounds how long one connection may hold a buffered upload. */
  requestTimeoutMs: number;
  /** How long the request head may take to arrive. */
  headersTimeoutMs: number;
  /** How long an idle connection is kept for reuse. Must exceed the idle timeout of whatever fronts this server. */
  keepAliveTimeoutMs: number;
  /**
   * The idle timeout of the proxy or balancer in front of this server, which `keepAliveTimeoutMs` is checked
   * against. `0` declares that nothing fronts it and skips that check — a loopback-only listener, or a
   * self-hosted deployment exposing the port directly.
   */
  frontingProxyIdleTimeoutMs: number;
};

/**
 * Rejected rather than clamped: every one of these means the operator asked for a deadline that cannot hold,
 * and a server that silently substituted a working value would be back to an unreviewed default.
 */
export class HttpTimeoutConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpTimeoutConfigError";
  }
}

const FIELDS = ["requestTimeoutMs", "headersTimeoutMs", "keepAliveTimeoutMs"] as const;

/**
 * Node's timer ceiling. Above it the duration is silently truncated to this value — roughly 24 days, not the
 * ~1 ms that `setTimeout`'s own overflow rule would give — and the configured number stops meaning anything.
 * Measured, not assumed: `TimeoutOverflowWarning` says "truncated to 2147483647".
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Applies the three deadlines to an already-listening server.
 *
 * Call it *after* `listen()`: Nest has no `http.Server` to hand out before then.
 */
export function applyHttpServerTimeouts(server: Server, timeouts: HttpServerTimeouts): void {
  for (const field of FIELDS) {
    const value = timeouts[field];
    // Zero is Node's spelling of "no deadline", so it has to be refused here rather than passed through — it is
    // the exact fail-open this function exists to remove.
    if (!Number.isInteger(value) || value <= 0) {
      throw new HttpTimeoutConfigError(
        `${field} must be a positive whole number of milliseconds; got ${JSON.stringify(value)}`,
      );
    }
    if (value > MAX_TIMEOUT_MS) {
      throw new HttpTimeoutConfigError(
        `${field} (${value}) exceeds Node's timer ceiling of ${MAX_TIMEOUT_MS}ms, above which the duration is ` +
          `truncated and the configured value stops applying`,
      );
    }
  }

  if (
    !Number.isInteger(timeouts.frontingProxyIdleTimeoutMs) ||
    timeouts.frontingProxyIdleTimeoutMs < 0 ||
    timeouts.frontingProxyIdleTimeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new HttpTimeoutConfigError(
      `frontingProxyIdleTimeoutMs must be a whole number of milliseconds between 0 and ${MAX_TIMEOUT_MS}; ` +
        `got ${JSON.stringify(timeouts.frontingProxyIdleTimeoutMs)}`,
    );
  }

  const { requestTimeoutMs, headersTimeoutMs, keepAliveTimeoutMs, frontingProxyIdleTimeoutMs } = timeouts;

  // The 502 this whole module exists for, enforced rather than left to the default: a balancer that holds an
  // idle connection longer than the server does will reuse one the server has already closed. `0` is how a
  // deployment with nothing in front of it says so — it is not a disabled check by accident.
  if (frontingProxyIdleTimeoutMs > 0 && keepAliveTimeoutMs <= frontingProxyIdleTimeoutMs) {
    throw new HttpTimeoutConfigError(
      `keepAliveTimeoutMs (${keepAliveTimeoutMs}) must exceed the fronting proxy's idle timeout ` +
        `(${frontingProxyIdleTimeoutMs}), or the proxy reuses a connection this server has already closed and ` +
        `answers 502. Set frontingProxyIdleTimeoutMs to 0 only when nothing fronts this server.`,
    );
  }

  // Node measures the headers deadline from when the connection goes idle, not from the first byte of the next
  // request. An idle connection whose headers deadline is the shorter of the two is therefore torn down mid-reuse
  // instead of being closed cleanly at the keep-alive deadline, which the client sees as a reset.
  if (headersTimeoutMs <= keepAliveTimeoutMs) {
    throw new HttpTimeoutConfigError(
      `headersTimeoutMs (${headersTimeoutMs}) must be greater than keepAliveTimeoutMs (${keepAliveTimeoutMs})`,
    );
  }

  // The head is part of the request, so a request deadline below the headers deadline makes the latter
  // unreachable — the connection dies on the request deadline and the headers setting never applies.
  if (requestTimeoutMs < headersTimeoutMs) {
    throw new HttpTimeoutConfigError(
      `requestTimeoutMs (${requestTimeoutMs}) must be at least headersTimeoutMs (${headersTimeoutMs})`,
    );
  }

  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;
}

/**
 * The idle timeout of the load balancer in front of the public services, in milliseconds.
 *
 * It is an AWS default this deployment has never overridden, and it lives here as a number because
 * `keepAliveTimeoutMs` below has to be compared against something. Terraform owns the real value in another
 * repository; if it is ever raised, this constant and the default under it move in the same change.
 */
export const FRONTING_PROXY_IDLE_TIMEOUT_MS = 60_000;

/**
 * The defaults all three serving entrypoints fall back to, in one place so the three services cannot drift
 * apart and so a change to any of them is a change to a single reviewed line.
 */
export const HTTP_TIMEOUT_DEFAULTS: HttpServerTimeouts = {
  // Node's own default, kept deliberately: this value bounds how long one connection may hold a buffered
  // upload, so lowering it trades a slow submitter's upload against memory held per connection. Changing it
  // needs measured archive sizes and upload durations, not a guess — see docs/specs/configuration.md §11.
  requestTimeoutMs: 300_000,
  headersTimeoutMs: 70_000,
  // Above FRONTING_PROXY_IDLE_TIMEOUT_MS, which is the whole point: below it, the balancer reuses a connection
  // Node has already closed and answers 502.
  keepAliveTimeoutMs: 65_000,
  frontingProxyIdleTimeoutMs: FRONTING_PROXY_IDLE_TIMEOUT_MS,
};
