import { clampConcurrency, clampTestnetConcurrency } from "../src/config/configuration.js";

describe("clampTestnetConcurrency", () => {
  it("falls back to the global cap when unset — the decision's central promise", () => {
    expect(clampTestnetConcurrency(undefined, 4)).toBe(4);
  });

  it("admits 0 as a legitimate ceiling — deny all testnet jobs", () => {
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
