import { describe, expect, test } from "vitest";
import { readVerdict } from "@/features/verification/utils/preflight.util";

describe("readVerdict — the two passing arms", () => {
  test("chain_named is ready", () => {
    expect(
      readVerdict({ kind: "chain_named", image: "docker.io/stellar/stellar-cli@sha256:" + "a".repeat(64), trustLevel: "official_trusted" }),
    ).toEqual({ gate: "ready", kind: "chain_named" });
  });

  test("compose is ready", () => {
    expect(readVerdict({ kind: "compose", intent: {}, trustLevel: "upstream_pinned" })).toEqual({
      gate: "ready",
      kind: "compose",
    });
  });
});

describe("readVerdict — unsupported toolchains", () => {
  test.each(["unreleased_cli", "undated_nightly", "missing_toolchain_pair"] as const)(
    "%s blocks and is labelled unsupported",
    (reason) => {
      expect(readVerdict({ kind: "unsupported", reason })).toEqual({
        gate: "blocked",
        label: "unsupported",
        reason,
      });
    },
  );
});

describe("readVerdict — one arm, two labels", () => {
  test("image_not_official_trusted is unsupported, not policy_rejected", () => {
    const verdict = readVerdict({
      kind: "chain_named_policy_rejected",
      reason: "image_not_official_trusted",
      detail: "M1 only accepts docker.io/stellar/stellar-cli digest-pinned images.",
    });

    expect(verdict).toEqual({ gate: "blocked", label: "unsupported", reason: "image_not_official_trusted" });
  });

  test("image_not_digest_pinned is policy_rejected, and carries the detail to act on", () => {
    const verdict = readVerdict({
      kind: "chain_named_policy_rejected",
      reason: "image_not_digest_pinned",
      detail: "build.image must be a fully qualified digest-pinned reference.",
    });

    expect(verdict).toEqual({
      gate: "blocked",
      label: "policy_rejected",
      reason: "image_not_digest_pinned",
      detail: "build.image must be a fully qualified digest-pinned reference.",
    });
  });

  test("the two reasons never share a label", () => {
    const a = readVerdict({ kind: "chain_named_policy_rejected", reason: "image_not_official_trusted", detail: "" });
    const b = readVerdict({ kind: "chain_named_policy_rejected", reason: "image_not_digest_pinned", detail: "" });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a && "label" in a ? a.label : null).not.toBe(b && "label" in b ? b.label : null);
  });
});

describe("readVerdict — fails closed", () => {
  test.each([
    ["an arm added after this bundle shipped", { kind: "some_future_arm" }],
    ["a known arm with an unknown reason", { kind: "unsupported", reason: "who_knows" }],
    ["a policy rejection with an unknown reason", { kind: "chain_named_policy_rejected", reason: "nope", detail: "" }],
    ["no kind at all", { image: "x" }],
    ["not an object", "chain_named"],
    ["null", null],
    ["undefined", undefined],
  ])("%s returns null so the caller can block", (_label, input) => {
    expect(readVerdict(input)).toBeNull();
  });
});
