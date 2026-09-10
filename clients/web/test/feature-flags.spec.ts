import { afterEach, describe, expect, test, vi } from "vitest";
import { isAggregatorEnabled } from "@/config/features";

/** What `docker/web-entrypoint.sh` leaves in `index.html` when nothing substituted the placeholder. */
const UNSUBSTITUTED = "__SCVS_ENABLE_AGGREGATOR__";

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.__SCVS_RUNTIME_CONFIG__;
});

// A truthy-ish value slipping through would ship the page.
describe("isAggregatorEnabled — the build-time value", () => {
  test("unset is off", () => {
    vi.stubEnv("VITE_ENABLE_AGGREGATOR", undefined as unknown as string);
    expect(isAggregatorEnabled()).toBe(false);
  });

  test("the exact string `true` enables it", () => {
    vi.stubEnv("VITE_ENABLE_AGGREGATOR", "true");
    expect(isAggregatorEnabled()).toBe(true);
  });

  test.each(["", "false", "0", "1", "TRUE", "True", "yes", " true "])("%p does not", (value) => {
    vi.stubEnv("VITE_ENABLE_AGGREGATOR", value);
    expect(isAggregatorEnabled()).toBe(false);
  });
});

// The container's value, substituted into index.html at start-up.
describe("isAggregatorEnabled — the runtime value", () => {
  test("`true` enables it over a bundle built with nothing", () => {
    vi.stubEnv("VITE_ENABLE_AGGREGATOR", undefined as unknown as string);
    window.__SCVS_RUNTIME_CONFIG__ = { enableAggregator: "true" };
    expect(isAggregatorEnabled()).toBe(true);
  });

  test("`false` disables it over a bundle built with `true`", () => {
    vi.stubEnv("VITE_ENABLE_AGGREGATOR", "true");
    window.__SCVS_RUNTIME_CONFIG__ = { enableAggregator: "false" };
    expect(isAggregatorEnabled()).toBe(false);
  });

  // Stubbing the build-time value is what makes the assertion mean anything.
  test("the unset-in-production empty string overrides a bundle built with `true`", () => {
    vi.stubEnv("VITE_ENABLE_AGGREGATOR", "true");
    window.__SCVS_RUNTIME_CONFIG__ = { enableAggregator: "" };
    expect(isAggregatorEnabled()).toBe(false);
  });

  test.each(["TRUE", "yes", "1", " true "])("%p is off even over a bundle built with `true`", (value) => {
    vi.stubEnv("VITE_ENABLE_AGGREGATOR", "true");
    window.__SCVS_RUNTIME_CONFIG__ = { enableAggregator: value };
    expect(isAggregatorEnabled()).toBe(false);
  });

  // A dev server substitutes nothing. Reading the placeholder as a value would be reading a non-empty string,
  // and the fallback would never be consulted.
  test("an unsubstituted placeholder falls through to the build-time value", () => {
    vi.stubEnv("VITE_ENABLE_AGGREGATOR", "true");
    window.__SCVS_RUNTIME_CONFIG__ = { enableAggregator: UNSUBSTITUTED };
    expect(isAggregatorEnabled()).toBe(true);
  });

  test("an unsubstituted placeholder does not enable it on its own", () => {
    vi.stubEnv("VITE_ENABLE_AGGREGATOR", undefined as unknown as string);
    window.__SCVS_RUNTIME_CONFIG__ = { enableAggregator: UNSUBSTITUTED };
    expect(isAggregatorEnabled()).toBe(false);
  });
});
