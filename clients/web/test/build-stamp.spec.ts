import { describe, expect, test } from "vitest";
import {
  BUILD_META_NAME,
  BuildStampError,
  UNSTAMPED,
  buildStamp,
  buildStampPlugin,
} from "../build-stamp";

const COMMIT = "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5";

describe("the stamp reads as a date first, so two builds sort by eye", () => {
  test("a commit and its date", () => {
    expect(buildStamp(COMMIT, "2026-09-16")).toBe("2026-09-16.1a2b3c4");
  });

  test("only seven characters of the commit reach the page", () => {
    expect(buildStamp(COMMIT, "2026-09-16")).not.toContain(COMMIT);
  });

  test("a commit already shortened is left as it is", () => {
    expect(buildStamp("1a2b3c4", "2026-09-16")).toBe("2026-09-16.1a2b3c4");
  });

  test("neither half set is a local build, which has no deployment to be newer than", () => {
    expect(buildStamp(undefined, undefined)).toBe(UNSTAMPED);
    expect(buildStamp("", "")).toBe(UNSTAMPED);
  });
});

describe("it refuses a stamp it cannot trust, rather than rendering one that reads real", () => {
  test.each([
    ["a commit with no date", COMMIT, undefined],
    ["a date with no commit", undefined, "2026-09-16"],
  ])("%s", (_name, commit, date) => {
    expect(() => buildStamp(commit, date)).toThrow(BuildStampError);
  });

  test.each(["1a2b3c", "not-a-commit", "1A2B3C4", `${COMMIT}0`])(
    "a commit that is not one (%s)",
    (commit) => {
      expect(() => buildStamp(commit, "2026-09-16")).toThrow(/not a commit/);
    },
  );

  test.each(["16-09-2026", "2026-9-16", "2026-09-16T00:00:00Z"])(
    "a date that is not YYYY-MM-DD (%s)",
    (date) => {
      expect(() => buildStamp(COMMIT, date)).toThrow(/not a YYYY-MM-DD date/);
    },
  );
});

describe("the plugin puts the stamp where a browser and a curl both find it", () => {
  test("it injects one meta tag into the head", () => {
    const plugin = buildStampPlugin({
      SCVS_BUILD_COMMIT: COMMIT,
      SCVS_BUILD_DATE: "2026-09-16",
    });
    const transform = plugin.transformIndexHtml;
    if (typeof transform !== "function") throw new Error("transformIndexHtml is not a function");

    expect(transform.call(null as never, "", null as never)).toEqual([
      {
        tag: "meta",
        attrs: { name: BUILD_META_NAME, content: "2026-09-16.1a2b3c4" },
        injectTo: "head",
      },
    ]);
  });

  // At construction, not at bundle time: a build that got this far would already have produced output.
  test("a malformed stamp fails the config, not the bundle", () => {
    expect(() => buildStampPlugin({ SCVS_BUILD_COMMIT: COMMIT })).toThrow(BuildStampError);
  });
});
