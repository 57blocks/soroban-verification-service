import { describe, expect, test } from "vitest";
import {
  maskHex,
  scrambleFrame,
} from "@/features/landing/utils/hash-scramble.util";

const digest = "a91c…d8a3";

describe("maskHex", () => {
  test("masks every hex character and keeps the rest", () => {
    expect(maskHex(digest)).toBe("····…····");
  });
});

describe("scrambleFrame", () => {
  test("settles on the exact target at the end", () => {
    expect(scrambleFrame(digest, 1)).toBe(digest);
    expect(scrambleFrame(digest, 1.4)).toBe(digest);
  });

  test("scrambles every hex position at the start", () => {
    expect(scrambleFrame(digest, 0, () => 0.99)).toBe("ffff…ffff");
  });

  test("settles hex characters from left to right", () => {
    expect(scrambleFrame(digest, 0.5, () => 0.99)).toBe("a91c…ffff");
  });

  test.each([0, 0.2, 0.5, 0.8, 0.99])(
    "keeps length and non-hex characters at %s",
    (progress) => {
      const frame = scrambleFrame(digest, progress);
      expect([...frame]).toHaveLength([...digest].length);
      expect([...frame][4]).toBe("…");
      expect(frame).toMatch(/^[0-9a-f]{4}…[0-9a-f]{4}$/);
    },
  );
});
