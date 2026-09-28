import { describe, expect, test } from "vitest";
import { CONSOLE_ROUTE_PATHS } from "@/app/route-paths";
import { SpaRoutesError, locationMatcher, renderSpaRoutesConf } from "../spa-routes";

describe("a route becomes one nginx location", () => {
  test("a path with no parameters is an exact match, which nginx resolves before any regex", () => {
    expect(locationMatcher("/verify")).toBe("= /verify");
    expect(locationMatcher("/")).toBe("= /");
  });

  test("a parameter matches one segment, so a deeper path is not this route", () => {
    expect(locationMatcher("/verify/jobs/$job_id")).toBe("~ ^/verify/jobs/[^/]+$");
  });

  test("a literal segment's regex metacharacters are escaped", () => {
    expect(locationMatcher("/wasms.json/$hash")).toBe("~ ^/wasms\\.json/[^/]+$");
  });
});

describe("it refuses what it cannot render, rather than emitting a wrong allowlist", () => {
  test.each(["verify", "", "./verify"])("a non-absolute path (%s)", (path) => {
    expect(() => locationMatcher(path)).toThrow(SpaRoutesError);
  });

  test("an empty segment", () => {
    expect(() => locationMatcher("/verify//jobs")).toThrow(/empty segment/);
  });

  test.each(["/files/$", "/files/*"])("a splat (%s)", (path) => {
    expect(() => locationMatcher(path)).toThrow(/splat/);
  });

  test("an unreadable parameter", () => {
    expect(() => locationMatcher("/verify/jobs/$9")).toThrow(/unreadable parameter/);
  });

  test("a duplicated path", () => {
    expect(() => renderSpaRoutesConf(["/verify", "/verify"])).toThrow(/listed twice/);
  });
});

describe("the rendered file", () => {
  const conf = renderSpaRoutesConf();

  test("carries one location per declared route and nothing else", () => {
    const locations = conf.split("\n").filter((line) => line.startsWith("location "));
    expect(locations).toHaveLength(CONSOLE_ROUTE_PATHS.length);
    for (const line of locations) {
      expect(line).toMatch(/\{ try_files \/index\.html =404; \}$/);
    }
  });

  test("says where it came from, since nothing should edit it in place", () => {
    expect(conf).toMatch(/^# Generated from clients\/web\/src\/app\/route-paths\.ts/);
    expect(conf).toMatch(/Do not edit\./);
  });

  test("puts the exact matches before the regexes, the order nginx matches in", () => {
    const kinds = conf
      .split("\n")
      .filter((line) => line.startsWith("location "))
      .map((line) => (line.includes("location = ") ? "exact" : "regex"));
    expect(kinds.indexOf("regex")).toBe(kinds.lastIndexOf("exact") + 1);
  });
});
