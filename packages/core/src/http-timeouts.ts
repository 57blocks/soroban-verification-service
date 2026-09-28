import type { Server } from "node:http";

export type HttpServerTimeouts = {
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  /** `0` means nothing fronts this server and skips the keep-alive check. */
  frontingProxyIdleTimeoutMs: number;
};

export class HttpTimeoutConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpTimeoutConfigError";
  }
}

const FIELDS = ["requestTimeoutMs", "headersTimeoutMs", "keepAliveTimeoutMs"] as const;

/** Node's timer ceiling; larger values are silently truncated to it. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Call after `listen()`: Nest has no `http.Server` before then. */
export function applyHttpServerTimeouts(server: Server, timeouts: HttpServerTimeouts): void {
  for (const field of FIELDS) {
    const value = timeouts[field];
    // Node reads 0 as "no deadline", so it is refused.
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

  if (frontingProxyIdleTimeoutMs > 0 && keepAliveTimeoutMs <= frontingProxyIdleTimeoutMs) {
    throw new HttpTimeoutConfigError(
      `keepAliveTimeoutMs (${keepAliveTimeoutMs}) must exceed the fronting proxy's idle timeout ` +
        `(${frontingProxyIdleTimeoutMs}), or the proxy reuses a connection this server has already closed and ` +
        `answers 502. Set frontingProxyIdleTimeoutMs to 0 only when nothing fronts this server.`,
    );
  }

  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;
}

/** The ALB idle timeout (AWS default); must track the value the infrastructure sets. */
export const FRONTING_PROXY_IDLE_TIMEOUT_MS = 60_000;

export const HTTP_TIMEOUT_DEFAULTS: HttpServerTimeouts = {
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  // Must exceed the balancer's idle timeout, or it reuses connections Node has closed and answers 502.
  keepAliveTimeoutMs: 65_000,
  frontingProxyIdleTimeoutMs: FRONTING_PROXY_IDLE_TIMEOUT_MS,
};
