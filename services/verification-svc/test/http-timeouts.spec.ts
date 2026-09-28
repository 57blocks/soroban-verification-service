import { createServer } from "node:http";
import { applyHttpServerTimeouts, HTTP_TIMEOUT_DEFAULTS } from "@scvs/core";
import configuration from "../src/config/configuration.js";

const NAMES = [
  "SCVS_REQUEST_TIMEOUT_MS",
  "SCVS_HEADERS_TIMEOUT_MS",
  "SCVS_KEEPALIVE_TIMEOUT_MS",
  "SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS",
] as const;

describe("the HTTP deadlines this service loads", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("falls back to the shared defaults when nothing is set", () => {
    expect(configuration().httpTimeouts).toEqual(HTTP_TIMEOUT_DEFAULTS);
  });

  it("reaches a real http.Server with the loaded values, not the defaults", () => {
    process.env.SCVS_REQUEST_TIMEOUT_MS = "123000";
    process.env.SCVS_HEADERS_TIMEOUT_MS = "99000";
    process.env.SCVS_KEEPALIVE_TIMEOUT_MS = "90000";

    const server = createServer();
    applyHttpServerTimeouts(server, configuration().httpTimeouts);

    expect(server.requestTimeout).toBe(123_000);
    expect(server.headersTimeout).toBe(99_000);
    expect(server.keepAliveTimeout).toBe(90_000);
  });

  it("refuses to boot on a keep-alive under the balancer's idle timeout", () => {
    process.env.SCVS_KEEPALIVE_TIMEOUT_MS = "5000";
    expect(() => applyHttpServerTimeouts(createServer(), configuration().httpTimeouts)).toThrow(
      /must exceed the fronting proxy's idle timeout/,
    );
  });

  it("accepts a short keep-alive once the deployment declares nothing fronts it", () => {
    process.env.SCVS_FRONTING_PROXY_IDLE_TIMEOUT_MS = "0";
    process.env.SCVS_KEEPALIVE_TIMEOUT_MS = "5000";

    const server = createServer();
    applyHttpServerTimeouts(server, configuration().httpTimeouts);
    expect(server.keepAliveTimeout).toBe(5_000);
  });
});
