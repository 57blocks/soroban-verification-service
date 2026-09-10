import { describe, expect, test } from "vitest";
import { validateBuildOptions } from "@/features/verification/utils/build-options.util";

const rejectionFor = (raw: string) => {
  const result = validateBuildOptions(raw);
  if (result.ok) throw new Error(`expected ${raw} to be rejected`);
  return result.rejected[0];
};

describe("validateBuildOptions — replay, do not drop", () => {
  // It must survive validation, normalised.
  test("a manifest path inside the tree is kept, normalised", () => {
    expect(validateBuildOptions("--manifest-path=./contracts/./token/Cargo.toml")).toEqual({
      ok: true,
      normalized: ["--manifest-path=contracts/token/Cargo.toml"],
    });
  });

  test("an interior .. that stays inside the tree resolves rather than being rejected", () => {
    expect(validateBuildOptions("--manifest-path=contracts/token/../token/Cargo.toml")).toEqual({
      ok: true,
      normalized: ["--manifest-path=contracts/token/Cargo.toml"],
    });
  });

  // This asserted `"--locked --features a,b"` → `["--locked", "--features", "a,b"]`, which is the defect rather
  // than the contract: SO5 records one complete flag per entry, so `"a,b"` as its own entry is not publishable
  // and `packages/core`'s `RegistryVerification.bldopt` rejects it.
  test("options that take no path pass through untouched, in `=` form", () => {
    expect(validateBuildOptions("--locked --features=a,b")).toEqual({
      ok: true,
      normalized: ["--locked", "--features=a,b"],
    });
  });

  test("no options at all is fine", () => {
    expect(validateBuildOptions(undefined)).toEqual({ ok: true, normalized: [] });
    expect(validateBuildOptions("   ")).toEqual({ ok: true, normalized: [] });
  });
});

describe("validateBuildOptions — what leaves the source tree is rejected", () => {
  test.each([
    "--manifest-path=../../etc/passwd",
    "--manifest-path=/etc/passwd",
    "--manifest-path=contracts/../../outside/Cargo.toml",
    "--manifest-path=..\\\\windows\\\\system32",
    "--manifest-path=C:/windows/system32",
  ])("%s", (raw) => {
    expect(rejectionFor(raw).reason).toBe("path_escapes_source_tree");
  });

  // Normalising alone is what makes a traversal look safe — the check is on the *result*.
  test("a path that normalises back inside is not confused with one that escapes", () => {
    expect(validateBuildOptions("--manifest-path=a/../b/Cargo.toml").ok).toBe(true);
    expect(validateBuildOptions("--manifest-path=a/../../b/Cargo.toml").ok).toBe(false);
  });
});

describe("validateBuildOptions — options that would change the sandbox", () => {
  test.each(["--offline", "--config=x", "--env=SECRET=1", "--target-dir=out", "--out-dir=out"])(
    "%s is rejected as not replayable",
    (raw) => {
      expect(rejectionFor(raw).reason).toBe("not_replayable");
    },
  );

  test("a path option with no value is unparsable, not silently dropped", () => {
    expect(rejectionFor("--manifest-path").reason).toBe("unparsable");
  });
});

// SO5: one complete flag per entry, value attached by `=`. The server refuses the same input and is the gate.
describe("validateBuildOptions — a flag and its value cannot be separated", () => {
  test("the incident's own input names the fix instead of restating the rule", () => {
    const rejection = rejectionFor("--package reflector-pulse-contract");
    expect(rejection.option).toBe("reflector-pulse-contract");
    expect(rejection.reason).toBe("unparsable");
    expect(rejection.detail).toContain("--package=reflector-pulse-contract");
  });

  test("the `=` form of the same option is accepted", () => {
    expect(validateBuildOptions("--package=reflector-pulse-contract")).toEqual({
      ok: true,
      normalized: ["--package=reflector-pulse-contract"],
    });
  });

  test.each(["-p my-contract", "-p=my-contract"])("%s — a short flag is not representable", (raw) => {
    expect(rejectionFor(raw).detail).toContain("--package=");
  });

  test("a bare word with no flag before it is rejected without a bogus suggestion", () => {
    const rejection = rejectionFor("reflector-pulse-contract");
    expect(rejection.reason).toBe("unparsable");
    expect(rejection.detail).not.toContain("=reflector-pulse-contract");
  });

  // The valueless-long-flag case must keep its own, better message rather than being swallowed by the SO5 check
  // — `--manifest-path` alone is SO5-shaped, so precedence has to fall through.
  test("a valueless path option still reports what it needs", () => {
    expect(rejectionFor("--manifest-path").detail).toContain("--manifest-path=<path>");
  });
});

describe("validateBuildOptions — every rejection is actionable", () => {
  test("each carries the offending option and a reason to act on", () => {
    const result = validateBuildOptions("--offline --manifest-path=../x/Cargo.toml");
    if (result.ok) throw new Error("expected rejections");

    expect(result.rejected).toHaveLength(2);
    for (const entry of result.rejected) {
      expect(entry.option).toBeTruthy();
      expect(entry.detail.length).toBeGreaterThan(0);
    }
  });
});
