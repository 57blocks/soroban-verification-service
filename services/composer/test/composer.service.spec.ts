import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ComposerSmokeTest, RecordedToolchainPair } from "@scvs/core";
import { contextWithMessage, evaluateSmokeTest } from "../src/modules/composer/composer.service.js";
import { ImageError } from "../src/modules/composer/image.js";
import { ComponentError } from "../src/modules/composer/components.js";

describe("contextWithMessage", () => {
  it("keeps context.detail intact rather than overwriting it with error.message", () => {
    const error = new ImageError(
      "smoke_test_failed",
      "Could not run `stellar version` inside the composed image.",
      { tool: "stellar", detail: "stellar: command not found" },
    );

    const context = contextWithMessage(error);

    expect(context.detail).toBe("stellar: command not found");
    expect(context.tool).toBe("stellar");
    expect(context.message).toBe("Could not run `stellar version` inside the composed image.");
  });

  it("preserves every other context field alongside message", () => {
    const error = new ComponentError("component_checksum_mismatch", "Checksum mismatch.", {
      component: "rustup_installer",
      expected_sha256: "a".repeat(64),
      actual_sha256: "b".repeat(64),
    });

    const context = contextWithMessage(error);

    expect(context).toMatchObject({
      component: "rustup_installer",
      expected_sha256: "a".repeat(64),
      actual_sha256: "b".repeat(64),
      message: "Checksum mismatch.",
    });
  });

  it("still reports message when the thrower's context carried no detail of its own", () => {
    const error = new ImageError("ecr_auth_failed", "Could not obtain an ECR authorization token.", {});

    const context = contextWithMessage(error);

    expect(context.message).toBe("Could not obtain an ECR authorization token.");
    expect(context.detail).toBeUndefined();
  });
});

describe("evaluateSmokeTest", () => {
  const pair: RecordedToolchainPair = {
    cliver: "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4",
    rsver: "1.96.0",
  };

  function smokeTest(overrides: Partial<ComposerSmokeTest> = {}): ComposerSmokeTest {
    return {
      reported_cliver: "stellar 27.0.0 (5a7c5fe76530bf4248477ac812fc757146b98cc4)",
      reported_rsver: "rustc 1.96.0 (abcdef012 2026-05-04)",
      matches_pair: true,
      ...overrides,
    };
  }

  it("lets an agreeing image through with nothing to report", () => {
    expect(evaluateSmokeTest(pair, smokeTest())).toEqual({ agreed: true });
  });

  it("refuses a disagreeing image under the reason the receipt is read by", () => {
    const verdict = evaluateSmokeTest(pair, smokeTest({ matches_pair: false }));

    expect(verdict.agreed).toBe(false);
    expect(verdict).toMatchObject({ reason: "smoke_test_disagreed" });
  });

  it("★ carries both sides of both halves, which is the only way an operator can see how it differed", () => {
    const verdict = evaluateSmokeTest(
      pair,
      smokeTest({
        matches_pair: false,
        reported_cliver: "stellar 27.0.0 (93e1b1671f14830662766c005138b19095fe9307)",
        reported_rsver: "rustc 1.94.1 (000000000 2026-01-01)",
      }),
    );

    expect(verdict.agreed).toBe(false);
    if (verdict.agreed) return;
    expect(verdict.context).toEqual({
      requested_cliver: "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4",
      requested_rsver: "1.96.0",
      reported_cliver: "stellar 27.0.0 (93e1b1671f14830662766c005138b19095fe9307)",
      reported_rsver: "rustc 1.94.1 (000000000 2026-01-01)",
    });
  });

  it("★ treats a same-version, different-rev image as a disagreement, not a near-miss", () => {
    const verdict = evaluateSmokeTest(
      pair,
      smokeTest({ matches_pair: false, reported_cliver: "stellar 27.0.0 (93e1b167…)" }),
    );

    expect(verdict.agreed).toBe(false);
  });
});

describe("the composed image is pushed only after the smoke test agreed", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../src/modules/composer/composer.service.ts", import.meta.url)),
    "utf8",
  );

  const GATE = "if (!verdict.agreed) {";
  const PUSH = "await pushComposedImage({";

  it("has exactly one gate and one push, so the positions below mean what they say", () => {
    expect(SOURCE.split(GATE).length - 1).toBe(1);
    expect(SOURCE.split(PUSH).length - 1).toBe(1);
  });

  it("★ places the push after the gate", () => {
    expect(SOURCE.indexOf(GATE)).toBeLessThan(SOURCE.indexOf(PUSH));
  });

  it("★ leaves the method from inside the gate rather than falling through to the push", () => {
    const branch = SOURCE.slice(SOURCE.indexOf(GATE), SOURCE.indexOf(PUSH));
    expect(branch).toContain("return this.failure(");
  });
});
