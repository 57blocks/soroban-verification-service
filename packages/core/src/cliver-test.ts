import assert from "node:assert/strict";
import { parseCliver, sameCliBuild } from "./cliver.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const RELEASED = "25.1.0#a048a57ad0b9a09b4b0dee76c0dc2e4a0e4f4d3c";
const BETWEEN_RELEASES = "23.2.1#e7dd9394b99a6064c489be50434a66d2349d9d35";
const GIT_DESCRIBE = "26.0.0#v20.0.0-833-gd6f4b2a";

test("parseCliver: splits the released form into a release version and a build identity", () => {
  assert.deepEqual(parseCliver(RELEASED), {
    version: "25.1.0",
    rev: "a048a57ad0b9a09b4b0dee76c0dc2e4a0e4f4d3c",
  });
});

test("parseCliver: a commit between releases parses exactly like a released one", () => {
  assert.deepEqual(parseCliver(BETWEEN_RELEASES), {
    version: "23.2.1",
    rev: "e7dd9394b99a6064c489be50434a66d2349d9d35",
  });
});

test("parseCliver: a `git describe` rev is a rev, not a malformed sha", () => {
  assert.deepEqual(parseCliver(GIT_DESCRIBE), { version: "26.0.0", rev: "v20.0.0-833-gd6f4b2a" });
});

test("parseCliver: a value with no `#` yields a version and no rev, never a fabricated one", () => {
  assert.deepEqual(parseCliver("27.0.0"), { version: "27.0.0" });
});

test("parseCliver: refuses anything that could change the meaning of the URL it lands in", () => {
  for (const bad of [
    "",
    "#a048a57a",
    "25.1.0#",
    "../../etc/passwd",
    "25.1.0#a048#b048",
    "25.1.0#rev with spaces",
    "25 .1.0#a048a57a",
    "-25.1.0#a048a57a",
  ]) {
    assert.equal(parseCliver(bad), undefined, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test("sameCliBuild: the same version built at two different commits is not the same build", () => {
  assert.equal(
    sameCliBuild(
      "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4",
      "27.0.0#93e1b1671f14830662766c005138b19095fe9307",
    ),
    false,
  );
});

test("sameCliBuild: identical version and rev is a match", () => {
  assert.equal(sameCliBuild(RELEASED, RELEASED), true);
});

test("sameCliBuild: a missing rev is an unanswered question, not a wildcard", () => {
  assert.equal(sameCliBuild("25.1.0", RELEASED), false);
  assert.equal(sameCliBuild(RELEASED, "25.1.0"), false);
  assert.equal(sameCliBuild("25.1.0", "25.1.0"), false);
});

test("sameCliBuild: an unparseable value on either side is never a match", () => {
  assert.equal(sameCliBuild("../../etc/passwd", RELEASED), false);
  assert.equal(sameCliBuild(RELEASED, ""), false);
});

console.log("cliver: all cases passed");
