import assert from "node:assert/strict";
import { DENIED_IMAGE_DIGESTS, evaluateBuildImage, imagePolicyErrorCode, isDeniedImageDigest } from "./image-policy.js";

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
  assert.equal(result.trust_level, "official_trusted");
  assert.equal(result.evidence.checked, "digest_pinned_stellar_cli_image");
});

test("a well-formed but not-yet-accepted image is unsupported", () => {
  const result = evaluateBuildImage(UNTRUSTED_IMAGE);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "image_not_official_trusted");
  assert.equal(imagePolicyErrorCode(result.reason), "unsupported");
});

test("a non-digest-pinned reference is policy_rejected", () => {
  const result = evaluateBuildImage(TAG_ONLY_IMAGE);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "image_not_digest_pinned");
  assert.equal(imagePolicyErrorCode(result.reason), "policy_rejected");
});

test("the two reasons map to two distinct codes", () => {
  assert.notEqual(
    imagePolicyErrorCode("image_not_official_trusted"),
    imagePolicyErrorCode("image_not_digest_pinned"),
  );
});

test("an upper-case digest is judged by trust, not by shape", () => {
  const upper = `ghcr.io/someone/their-builder@sha256:${"A".repeat(64)}`;
  const result = evaluateBuildImage(upper);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "image_not_official_trusted");
});

test("anything that is not a string is refused on shape", () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    const result = evaluateBuildImage(bad);
    assert.equal(result.ok, false, `${String(bad)} must be refused`);
    if (result.ok) continue;
    assert.equal(result.reason, "image_not_digest_pinned");
  }
});

test("a denied digest of the official repository is unsupported", () => {
  const result = evaluateBuildImage(ACCEPTED_IMAGE, [`sha256:${DIGEST}`]);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "image_not_official_trusted");
  assert.equal(imagePolicyErrorCode(result.reason), "unsupported");
});

test("denying one digest leaves the rest of the repository accepted", () => {
  const other = `docker.io/stellar/stellar-cli@sha256:${"b".repeat(64)}`;
  assert.ok(evaluateBuildImage(other, [`sha256:${DIGEST}`]).ok);
});

test("an upper-case reference to a denied digest is still denied", () => {
  const upper = `docker.io/stellar/stellar-cli@sha256:${"A".repeat(64)}`;
  assert.equal(evaluateBuildImage(upper, [`sha256:${DIGEST}`]).ok, false);
  assert.ok(isDeniedImageDigest(`sha256:${"A".repeat(64)}`, [`sha256:${DIGEST}`]));
});

test("every shipped denylist entry is a lowercase prefixed digest, or it would match nothing", () => {
  for (const entry of DENIED_IMAGE_DIGESTS) {
    assert.match(entry, /^sha256:[0-9a-f]{64}$/);
  }
});
