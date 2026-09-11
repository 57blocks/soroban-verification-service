import { describe, expect, test } from "vitest";
import {
  DevProxyConfigError,
  devProxyServerConfig,
  ignoredEnvFileWarning,
  resolveDevProxy,
} from "../dev-proxy";

const TARGET = "https://dev.sv.example.com";

/** The configuration that works: a bare origin, both API bases empty. */
const valid = {
  VITE_DEV_API_PROXY: TARGET,
  VITE_VERIFY_API_URL: "",
  VITE_QUERY_API_URL: "",
};

describe("the dev proxy is off unless asked for", () => {
  test("no variable, no proxy", () => {
    expect(resolveDevProxy({})).toBeUndefined();
    expect(devProxyServerConfig(undefined)).toBeUndefined();
  });

  test("an empty or whitespace value is not a request for one", () => {
    expect(resolveDevProxy({ VITE_DEV_API_PROXY: "" })).toBeUndefined();
    expect(resolveDevProxy({ VITE_DEV_API_PROXY: "   " })).toBeUndefined();
  });

  test("a valid target resolves to its origin, and proxies /api", () => {
    expect(resolveDevProxy(valid)).toEqual({ target: TARGET });

    const config = devProxyServerConfig(resolveDevProxy(valid));
    expect(config?.["/api"]).toMatchObject({ target: TARGET, changeOrigin: true, secure: true });
    // The job page follows SSE through this, so the upgrade has to be proxied too.
    expect(config?.["/api"].ws).toBe(true);
  });

  // Both services are routed by path on one origin in a deployed environment, so one rule serves
  // `/api/verification/v1/...` and `/api/query/v1/...` alike.
  test("one rule covers both APIs", () => {
    expect(Object.keys(devProxyServerConfig(resolveDevProxy(valid)) ?? {})).toEqual(["/api"]);
  });
});

/** Failing at start-up, with the fix in the message, is the whole point. */
describe("a proxy that cannot work refuses to start", () => {
  test("a target with a path, which would double the /api prefix", () => {
    expect(() =>
      resolveDevProxy({ ...valid, VITE_DEV_API_PROXY: `${TARGET}/api/verification` }),
    ).toThrow(DevProxyConfigError);
    expect(() =>
      resolveDevProxy({ ...valid, VITE_DEV_API_PROXY: `${TARGET}/api/verification` }),
    ).toThrow(/no path, query or fragment/);
  });

  test("and the message names the origin to use instead", () => {
    expect(() =>
      resolveDevProxy({ ...valid, VITE_DEV_API_PROXY: `${TARGET}/api?x=1` }),
    ).toThrow(new RegExp(`Use ${TARGET}`));
  });

  test("a value that is not a URL", () => {
    expect(() => resolveDevProxy({ ...valid, VITE_DEV_API_PROXY: "dev.sv.example.com" })).toThrow(
      /not a URL/,
    );
  });

  test("a non-http scheme", () => {
    expect(() =>
      resolveDevProxy({ ...valid, VITE_DEV_API_PROXY: "ftp://dev.sv.example.com" }),
    ).toThrow(/must be http or https/);
  });

  /**
   * Unset and empty are different states for this variable: the console reports an absent base as "built
   * unconfigured" and calls nothing, which reads as the proxy being broken.
   */
  test("an unset verify base, which makes the console report itself unconfigured", () => {
    const withoutBase: Record<string, string | undefined> = { ...valid };
    delete withoutBase.VITE_VERIFY_API_URL;
    expect(() => resolveDevProxy(withoutBase)).toThrow(/VITE_VERIFY_API_URL=/);
    expect(() => resolveDevProxy(withoutBase)).toThrow(/unconfigured/);
  });

  test("a non-empty verify base, which skips the proxy and then fails CORS", () => {
    expect(() =>
      resolveDevProxy({ ...valid, VITE_VERIFY_API_URL: "http://localhost:5000" }),
    ).toThrow(/VITE_VERIFY_API_URL must be empty/);
  });

  test("a non-empty query base, which takes the aggregator off the proxy", () => {
    expect(() =>
      resolveDevProxy({ ...valid, VITE_QUERY_API_URL: "http://localhost:5001" }),
    ).toThrow(/VITE_QUERY_API_URL must be empty/);
  });

  test("both, named together rather than one at a time", () => {
    const error = (() => {
      try {
        resolveDevProxy({
          ...valid,
          VITE_VERIFY_API_URL: "http://localhost:5000",
          VITE_QUERY_API_URL: "http://localhost:5001",
        });
        return null;
      } catch (thrown) {
        return thrown as Error;
      }
    })();

    expect(error?.message).toMatch(/VITE_VERIFY_API_URL and VITE_QUERY_API_URL must be empty/);
    expect(error?.message).toContain("localhost:5000");
    expect(error?.message).toContain("localhost:5001");
  });
});

/** It looks exactly like the configuration, and its first symptom is the console reporting itself unconfigured. */
describe("env files in the package directory are called out", () => {
  const PKG = "/repo/clients/web/";
  const ENV_DIR = "/repo/";

  test("says which file, and where it should go", () => {
    const warning = ignoredEnvFileWarning(PKG, ENV_DIR, (path) => path === `${PKG}.env.local`);

    expect(warning).toMatch(/\.env\.local\} exists and is ignored/);
    expect(warning).toContain("/repo/.env.local");
    expect(warning).toMatch(/envDir is the repository root/);
  });

  test("names every ignored file rather than the first", () => {
    const present = new Set([`${PKG}.env`, `${PKG}.env.development.local`]);
    const warning = ignoredEnvFileWarning(PKG, ENV_DIR, (path) => present.has(path));

    expect(warning).toContain(".env,.env.development.local");
    expect(warning).toMatch(/exist and are ignored/);
  });

  test("silent when the package has none", () => {
    expect(ignoredEnvFileWarning(PKG, ENV_DIR, () => false)).toBeUndefined();
  });

  // Defensive: if envDir is ever pointed back at this package, these files are read and the warning would be
  // actively wrong.
  test("silent when envDir is the package directory itself", () => {
    expect(ignoredEnvFileWarning(PKG, PKG, () => true)).toBeUndefined();
    expect(ignoredEnvFileWarning("/repo/clients/web", PKG, () => true)).toBeUndefined();
  });
});
