import assert from "node:assert/strict";
import { HEX_SHA256, PREFIXED_SHA256 } from "./digest.js";
import { SEP58_HEX_SHA256 } from "./registry.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const LOWER = "a".repeat(64);
const UPPER = "A".repeat(64);

test("a digest is written in lower case, and only in lower case", () => {
  assert.equal(HEX_SHA256.test(LOWER), true);
  assert.equal(HEX_SHA256.test(UPPER), false);
  assert.equal(PREFIXED_SHA256.test(`sha256:${LOWER}`), true);
  assert.equal(PREFIXED_SHA256.test(`sha256:${UPPER}`), false);
});

test("the two shapes do not accept each other's spelling", () => {
  assert.equal(HEX_SHA256.test(`sha256:${LOWER}`), false);
  assert.equal(PREFIXED_SHA256.test(LOWER), false);
});

test("neither accepts a short, long, or non-hex digest", () => {
  for (const shape of [HEX_SHA256, PREFIXED_SHA256]) {
    const prefix = shape === PREFIXED_SHA256 ? "sha256:" : "";
    assert.equal(shape.test(`${prefix}${"a".repeat(63)}`), false, "63 characters");
    assert.equal(shape.test(`${prefix}${"a".repeat(65)}`), false, "65 characters");
    assert.equal(shape.test(`${prefix}${"g".repeat(64)}`), false, "not hex");
    assert.equal(shape.test(""), false, "empty");
  }
});

test("the SEP-58 name and the house shape are the same pattern", () => {
  assert.equal(SEP58_HEX_SHA256, HEX_SHA256);
});

test("the shared instances are stateless", () => {
  for (const shape of [HEX_SHA256, PREFIXED_SHA256]) {
    assert.equal(shape.global, false);
    assert.equal(shape.sticky, false);
  }
});
