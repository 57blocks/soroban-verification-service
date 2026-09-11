import { evaluateBuildImage, imagePolicyErrorCode } from "../src/modules/preflight/policy.js";

/**
 * `unsupported` and `policy_rejected` are disjoint, and telling them apart is the whole point: a well-formed
 * digest-pinned image policy has not accepted *yet* is "come back later", while a tag-only reference is "fix
 * your submission".
 */
const UNTRUSTED_IMAGE = `ghcr.io/someone/their-builder@sha256:${"a".repeat(64)}`;
const TAG_ONLY_IMAGE = "docker.io/stellar/stellar-cli:26.0.0";

describe("imagePolicyErrorCode", () => {
  it("calls a well-formed but not-yet-accepted image unsupported", () => {
    const result = evaluateBuildImage(UNTRUSTED_IMAGE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("image_not_sdf_trusted");
    expect(imagePolicyErrorCode(result.reason)).toBe("unsupported");
  });

  it("calls a non-digest-pinned reference policy_rejected", () => {
    const result = evaluateBuildImage(TAG_ONLY_IMAGE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("image_not_digest_pinned");
    expect(imagePolicyErrorCode(result.reason)).toBe("policy_rejected");
  });

  // The two reasons must map to two codes. One code for both is the defect this exists to prevent.
  it("maps the two reasons to two distinct codes", () => {
    expect(imagePolicyErrorCode("image_not_sdf_trusted")).not.toBe(
      imagePolicyErrorCode("image_not_digest_pinned"),
    );
  });
});
