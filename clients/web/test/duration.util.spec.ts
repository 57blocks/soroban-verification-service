import { describe, expect, test } from "vitest";
import {
  formatDateTime,
  formatDuration,
  parseTimestamp,
} from "@/features/verification/utils/duration.util";

describe("formatDuration", () => {
  test("keeps seconds at every scale, because a 3m02s build and a 3m58s build are different builds", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(3 * 60_000 + 2_000)).toBe("3m 02s");
    expect(formatDuration(3 * 60_000 + 58_000)).toBe("3m 58s");
    expect(formatDuration(3_600_000 + 4 * 60_000 + 12_000)).toBe("1h 04m 12s");
  });

  test("truncates rather than rounds, so an elapsed counter never shows a second that has not passed", () => {
    expect(formatDuration(1_999)).toBe("1s");
  });

  test("never renders a negative or non-finite duration", () => {
    expect(formatDuration(-5_000)).toBe("0s");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

describe("parseTimestamp", () => {
  test("reads an ISO instant", () => {
    expect(parseTimestamp("2026-08-18T05:52:30.148Z")).toBe(
      Date.parse("2026-08-18T05:52:30.148Z"),
    );
  });

  test("is undefined for anything that is not one, rather than 0", () => {
    expect(parseTimestamp(undefined)).toBeUndefined();
    expect(parseTimestamp("")).toBeUndefined();
    expect(parseTimestamp("not a date")).toBeUndefined();
  });
});

describe("formatDateTime", () => {
  test("renders an instant without throwing on a locale this environment may not carry", () => {
    expect(formatDateTime(Date.parse("2026-08-18T05:52:30.148Z"))).toMatch(/\d/);
  });
});
