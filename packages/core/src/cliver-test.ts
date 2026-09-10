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

const RELEASED = "25.1.0#a048a57ad0b9a09b4b0dee76c0dc2e4a0e4f4d3c"; // §4, LayerZero — the v25.1.0 tag commit
const BETWEEN_RELEASES = "23.2.1#e7dd9394b99a6064c489be50434a66d2349d9d35"; // §3, no tag points at it
const GIT_DESCRIBE = "26.0.0#v20.0.0-833-gd6f4b2a"; // §4, an SDF experiment build

test("parseCliver: splits the released form into a release version and a build identity", () => {
  assert.deepEqual(parseCliver(RELEASED), {
    version: "25.1.0",
    rev: "a048a57ad0b9a09b4b0dee76c0dc2e4a0e4f4d3c",
  });
});

test("parseCliver: a commit between releases parses exactly like a released one", () => {
  // Refusing it here would be a guess, and a wrong guess routes an honest contract to a published-nothing
  // outcome.
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
  // `version` is interpolated into `/releases/tags/v<version>`. These are the shapes that guard is for;
  // `../../etc/passwd` is the case `services/composer`'s own suite already pinned.
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
  // Both sides are honest `27.0.0` CLIs; one is the released v27.0.0 (`5a7c5fe7…`, which is what the official
  // Docker image pins) and one is not.
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
  // Neither direction may match: "25.1.0" does not identify a build, so nothing can be shown to be that build,
  // and failing closed costs at most a trust level (`sdf_trusted` -> `upstream_pinned`) while failing open
  // would cost correctness.
  assert.equal(sameCliBuild("25.1.0", RELEASED), false);
  assert.equal(sameCliBuild(RELEASED, "25.1.0"), false);
  assert.equal(sameCliBuild("25.1.0", "25.1.0"), false);
});

test("sameCliBuild: an unparseable value on either side is never a match", () => {
  assert.equal(sameCliBuild("../../etc/passwd", RELEASED), false);
  assert.equal(sameCliBuild(RELEASED, ""), false);
});

console.log("cliver: all cases passed");
