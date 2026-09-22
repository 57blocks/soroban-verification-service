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

// The two shapes exist because two vocabularies do, and mixing them is the mistake worth catching: a DTO
// field that takes the bare form must refuse the prefixed one, and the reverse.
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

// `SEP58_HEX_SHA256` is the published contract's name for the same shape. Keeping it as a name rather than a
// second literal is the point: a reader of `registry.ts` sees the SEP's vocabulary, and there is still only
// one pattern to change.
test("the SEP-58 name and the house shape are the same pattern", () => {
  assert.equal(SEP58_HEX_SHA256, HEX_SHA256);
});

// No `g` or `y` flag, so one shared instance carries no `lastIndex` between call sites. Sharing a stateful
// regex across a dozen DTO decorators would make validation depend on call order.
test("the shared instances are stateless", () => {
  for (const shape of [HEX_SHA256, PREFIXED_SHA256]) {
    assert.equal(shape.global, false);
    assert.equal(shape.sticky, false);
  }
});
