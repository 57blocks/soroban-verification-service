import assert from "node:assert/strict";
import { evaluateBuildImage, imagePolicyErrorCode } from "./image-policy.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const DIGEST = "a".repeat(64);
const ACCEPTED_IMAGE = `docker.io/stellar/stellar-cli@sha256:${DIGEST}`;
const UNTRUSTED_IMAGE = `ghcr.io/someone/their-builder@sha256:${DIGEST}`;
const TAG_ONLY_IMAGE = "docker.io/stellar/stellar-cli:26.0.0";

test("the official digest-pinned CLI image is accepted, with its evidence", () => {
  const result = evaluateBuildImage(ACCEPTED_IMAGE);
  assert.ok(result.ok);
  assert.equal(result.image, ACCEPTED_IMAGE);
  assert.equal(result.trust_level, "sdf_trusted");
  assert.equal(result.evidence.checked, "digest_pinned_stellar_cli_image");
});

// `unsupported` and `policy_rejected` are disjoint, and telling them apart is the whole point: a well-formed
// digest-pinned image policy has not accepted *yet* is "come back later", while a tag-only reference is "fix
// your submission".
test("a well-formed but not-yet-accepted image is unsupported", () => {
  const result = evaluateBuildImage(UNTRUSTED_IMAGE);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "image_not_sdf_trusted");
  assert.equal(imagePolicyErrorCode(result.reason), "unsupported");
});

test("a non-digest-pinned reference is policy_rejected", () => {
  const result = evaluateBuildImage(TAG_ONLY_IMAGE);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "image_not_digest_pinned");
  assert.equal(imagePolicyErrorCode(result.reason), "policy_rejected");
});

// The two reasons must map to two codes. One code for both is the defect this exists to prevent.
test("the two reasons map to two distinct codes", () => {
  assert.notEqual(
    imagePolicyErrorCode("image_not_sdf_trusted"),
    imagePolicyErrorCode("image_not_digest_pinned"),
  );
});

// The shape rung is derived from `BLDIMG_PATTERN` with the `i` flag both service copies carried. An upper-case
// digest is therefore well-formed here and stops at the trust rung, not the shape one — worth pinning, because
// `BLDIMG_PATTERN` itself is lower-case only and governs what may be published.
test("an upper-case digest is judged by trust, not by shape", () => {
  const upper = `ghcr.io/someone/their-builder@sha256:${"A".repeat(64)}`;
  const result = evaluateBuildImage(upper);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "image_not_sdf_trusted");
});

test("anything that is not a string is refused on shape", () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    const result = evaluateBuildImage(bad);
    assert.equal(result.ok, false, `${String(bad)} must be refused`);
    if (result.ok) continue;
    assert.equal(result.reason, "image_not_digest_pinned");
  }
});
