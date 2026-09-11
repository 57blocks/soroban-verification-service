import { clampConcurrency, clampTestnetConcurrency } from "../src/config/configuration.js";

/**
 * Both are otherwise only reached indirectly through the full `configuration()` factory, which also calls
 * functions that throw on unrelated unset env vars.
 */
describe("clampTestnetConcurrency", () => {
  it("falls back to the global cap when unset — the decision's central promise", () => {
    // A deployment that never configures SCVS_WORKER_CONCURRENCY_TESTNET must see no behaviour change: testnet
    // can still take every slot up to the global cap.
    expect(clampTestnetConcurrency(undefined, 4)).toBe(4);
  });

  it("admits 0 as a legitimate ceiling — deny all testnet jobs", () => {
    // Unlike clampConcurrency's floor of 1, 0 is a real configuration here (see the function's own comment):
    // the floor is 0 precisely so an operator can shut testnet dispatch off entirely.
    expect(clampTestnetConcurrency("0", 4)).toBe(0);
  });

  it("clamps a value above the global cap down to the global cap", () => {
    expect(clampTestnetConcurrency("99", 4)).toBe(4);
  });

  it("falls back to the global cap on a negative value", () => {
    expect(clampTestnetConcurrency("-1", 4)).toBe(4);
  });

  it("falls back to the global cap on a non-numeric value", () => {
    expect(clampTestnetConcurrency("abc", 4)).toBe(4);
  });

  it("accepts a value within the global cap unchanged", () => {
    expect(clampTestnetConcurrency("2", 4)).toBe(2);
  });
});

describe("clampConcurrency", () => {
  it("defaults to 1 when unset", () => {
    expect(clampConcurrency(undefined)).toBe(1);
  });

  it("clamps a value above 8 down to 8", () => {
    expect(clampConcurrency("99")).toBe(8);
  });

  it("falls back to 1 on a value below 1", () => {
    expect(clampConcurrency("0")).toBe(1);
    expect(clampConcurrency("-1")).toBe(1);
  });

  it("falls back to 1 on a non-numeric value", () => {
    expect(clampConcurrency("abc")).toBe(1);
  });
});
